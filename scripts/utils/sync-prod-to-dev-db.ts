/**
 * Incremental top-up sync: prod (Sydney) → liveone-dev.
 *
 *   PG_PROD_RO_DATABASE_URL=… LIVEONE_DEV_DATABASE_URL=… npm run db:sync-dev-db
 *
 * Keeps the shared `liveone-dev` database roughly in sync with prod between the
 * occasional full R2 restores. Reads prod with a SELECT-only role and writes
 * ONLY to liveone-dev — the app never touches prod, and this job can't either:
 *
 *   1. Prod credential is a `pg_read_all_data` role (no INSERT/UPDATE/DELETE/DDL).
 *   2. This script refuses to run if the WRITE target resolves to the prod
 *      branch/role (dev and prod share a host, so it compares the username and
 *      the PLANETSCALE_PROD_BRANCH_ID token) — a mis-pasted URL can't write prod.
 *
 * Strategy per table (see MANIFEST):
 *   - incremental (large, time-keyed): copy rows newer than the dev watermark
 *     (minus an overlap, to re-pull mutated/late rows) into an UNLOGGED staging
 *     table, then INSERT … ON CONFLICT.
 *   - full (small config): copy the whole table, upsert (no deletes — a dev
 *     mirror tolerates config rows that were removed in prod).
 *
 * Columns and primary keys are read from the DEST schema at runtime, so the
 * manifest only carries what can't be derived (watermark column, overlap,
 * conflict override for point_readings' unique index, FK-safety filter).
 *
 * Assumes liveone-dev shares prod's schema (true right after an R2 restore).
 * Requires `psql` on PATH.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Manifest ────────────────────────────────────────────────────────────────

type FullTable = {
  name: string;
  mode: "full";
  onConflict: "update" | "nothing";
  conflictCols?: string[]; // natural unique key when the PK is a divergent surrogate
  excludeCols?: string[]; // drop the surrogate id so dev keeps/assigns its own
  // Exact by-PK mirror: copy the prod serial `id` (restore-aligned), upsert on the PK, and DELETE
  // dev rows whose id is absent from prod. The ONLY correct keying when no single unique index is a
  // total non-null key (dashboards has TWO partial unique indexes, neither total). Wrapped in a txn;
  // realigns the serial after; FK children cascade on the orphan delete. Ignores conflictCols/excludeCols.
  mirror?: boolean;
};
type IncrementalTable = {
  name: string;
  mode: "incremental";
  watermark: string; // timestamp column used as the high-water mark on dev
  overlap: string; // re-pull window, e.g. "2 hours"
  onConflict: "update" | "nothing";
  conflictCols?: string[]; // override the PK (e.g. a unique index)
  excludeCols?: string[]; // columns to never copy (e.g. a serial id)
  filter?: string; // extra WHERE on the staging→dest INSERT (FK safety)
};
type Table = FullTable | IncrementalTable;

// Small config tables — full refresh, FK parents first.
const FULL: FullTable[] = [
  ...[
    "systems",
    "point_info",
    "users",
    "user_systems",
    "polling_status",
    "share_tokens",
    "roles",
    "areas",
  ].map((name): FullTable => ({ name, mode: "full", onConflict: "update" })),
  // Surrogate-key tables: the PK (uuid/serial `id`) is assigned independently on
  // dev, so dev and prod hold the same row under different ids. Upsert on the
  // NATURAL unique key and exclude `id` (like point_readings) — otherwise the
  // insert misses the PK conflict and trips the natural unique constraint,
  // aborting the whole sync before it reaches the readings tables.
  {
    name: "area_bindings",
    mode: "full",
    onConflict: "update",
    conflictCols: [
      "area_id",
      "role",
      "metric_type",
      "point_system_id",
      "point_id",
    ],
    excludeCols: ["id"],
  },
  // Run-tracking config. Upsert by the natural (system_id, role) key and exclude the surrogate
  // uuid `id` (assigned independently on dev, like area_bindings) — dev keeps its own id, which the
  // dev run-period recompute (db:recompute-dev-runs, see the workflow) uses for tracker_id. The
  // run periods themselves are NOT copied here: device_run_periods has a composite PK (can't use
  // mirror) and its rows shift/merge under recompute, so a copy would orphan stale rows — dev
  // recomputes them from the synced readings instead.
  {
    name: "device_trackers",
    mode: "full",
    onConflict: "update",
    conflictCols: ["system_id", "role"], // device_trackers_system_role_unique
    excludeCols: ["id"],
  },
  // Exact by-id mirror (see `mirror`). dashboards has TWO partial unique indexes —
  // (clerk_user_id, system_id) and (clerk_user_id, alias) — and BOTH columns are nullable, so
  // neither is a total non-null ON CONFLICT arbiter. The serial `id` is restore-aligned, so mirror by
  // PK and delete dev-only/divergent rows. Self-heals the composition-dashboard duplicates that caused
  // the alias collision. Cascade-deletes dev-only dashboard_share_tokens/grants for absent dashboards —
  // fine, dev is disposable.
  { name: "dashboards", mode: "full", onConflict: "update", mirror: true },
];

// Large, time-keyed tables — incremental. sessions before point_readings so the
// FK parent is present; point_readings only inserts readings whose session exists.
const INCREMENTAL: IncrementalTable[] = [
  {
    name: "sessions",
    mode: "incremental",
    watermark: "created_at",
    overlap: "6 hours",
    onConflict: "nothing",
  },
  {
    name: "point_readings",
    mode: "incremental",
    watermark: "created_at",
    overlap: "2 hours",
    onConflict: "nothing",
    conflictCols: ["system_id", "point_id", "measurement_time"], // pr_point_time_unique, not the serial PK
    excludeCols: ["id"], // dev assigns its own serial
    filter:
      "(session_id IS NULL OR session_id IN (SELECT id FROM public.sessions))",
  },
  {
    name: "point_readings_agg_5m",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 hours",
    onConflict: "update",
  },
  {
    name: "point_readings_agg_1d",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
  },
  {
    name: "point_readings_flow_1d",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
  },
];

const MANIFEST: Table[] = [...FULL, ...INCREMENTAL];

// ── psql helpers ──────────────────────────────────────────────────────────────

function psql(url: string, args: string[]): string {
  const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.status !== 0) {
    throw new Error(
      `psql failed (${res.status}): ${args.join(" ")}\n${res.stderr ?? ""}`,
    );
  }
  return (res.stdout ?? "").trim();
}

/** Scalar query (tuples-only, unaligned). Empty string when NULL/no rows. */
const scalar = (url: string, sql: string) => psql(url, ["-tAc", sql]);

/** Run statements, no result expected. */
const exec = (url: string, sql: string) => void psql(url, ["-c", sql]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// PlanetScale puts every branch on the same shared regional host; the BRANCH is
// encoded in the username (`postgres.<branch-id>`). So tell prod from dev by user.
function userOf(url: string): string {
  try {
    return new URL(url).username.toLowerCase();
  } catch {
    return "";
  }
}

// Column order and PK from the DEST (dev) catalog — both DBs share the schema.
function columnsOf(url: string, table: string): string[] {
  const out = scalar(
    url,
    `SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='${table}'`,
  );
  return out ? out.split(",") : [];
}

function pkOf(url: string, table: string): string[] {
  const out = scalar(
    url,
    `SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum))
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'public.${table}'::regclass AND i.indisprimary`,
  );
  return out ? out.split(",") : [];
}

// ── per-table sync ────────────────────────────────────────────────────────────

function syncTable(
  prodUrl: string,
  devUrl: string,
  scratch: string,
  t: Table,
): { table: string; rows: number } {
  const mirror = t.mode === "full" && t.mirror === true; // narrows t to FullTable
  const exclude = new Set(
    mirror ? [] : ((t as IncrementalTable).excludeCols ?? []),
  );
  const cols = columnsOf(devUrl, t.name).filter((c) => !exclude.has(c));
  if (cols.length === 0)
    throw new Error(`no columns found for ${t.name} (schema mismatch?)`);
  const colList = cols.join(", ");

  const pk = pkOf(devUrl, t.name);
  const conflictCols = mirror
    ? pk
    : ((t as IncrementalTable).conflictCols ?? pk);
  if (conflictCols.length === 0)
    throw new Error(`no conflict key for ${t.name}`);
  if (mirror && pk.length !== 1)
    throw new Error(
      `mirror ${t.name} requires a single-column PK (got ${pk.length})`,
    );

  // Source predicate: incremental ⇒ rows newer than (dev max − overlap).
  let predicate = "";
  if (t.mode === "incremental") {
    const wm = scalar(
      devUrl,
      `SELECT (max(${t.watermark}) - interval '${t.overlap}') FROM public.${t.name}`,
    );
    if (wm) predicate = `WHERE ${t.watermark} > '${wm}'`;
  }

  const dump = join(scratch, `${t.name}.tsv`);

  // 1. Export the delta from prod (read-only) to a local file (text/TSV → faithful NULLs).
  exec(
    prodUrl,
    `\\copy (SELECT ${colList} FROM public.${t.name} ${predicate}) TO '${dump}'`,
  );

  // 2. Stage on dev, then upsert. `LIKE` (no defaults) keeps the staging table from
  // burning the real serial sequence; drop NOT NULL on excluded cols so the partial
  // COPY (which omits them) doesn't trip a NOT NULL constraint.
  const dropNotNull = [...exclude]
    .map(
      (c) =>
        `ALTER TABLE sync_staging.${t.name} ALTER COLUMN ${c} DROP NOT NULL;`,
    )
    .join(" ");
  exec(
    devUrl,
    `CREATE SCHEMA IF NOT EXISTS sync_staging;
     DROP TABLE IF EXISTS sync_staging.${t.name};
     CREATE UNLOGGED TABLE sync_staging.${t.name} (LIKE public.${t.name}); ${dropNotNull}`,
  );
  exec(devUrl, `\\copy sync_staging.${t.name} (${colList}) FROM '${dump}'`);

  const rows =
    Number(scalar(devUrl, `SELECT count(*) FROM sync_staging.${t.name}`)) || 0;

  const conflictSet = new Set(conflictCols);
  const updatable = cols.filter((c) => !conflictSet.has(c));
  const action =
    t.onConflict === "update" && updatable.length > 0
      ? `DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`
      : "DO NOTHING";
  const filter = (t as IncrementalTable).filter
    ? `WHERE ${(t as IncrementalTable).filter}`
    : "";

  const upsert = `INSERT INTO public.${t.name} (${colList})
       SELECT ${colList} FROM sync_staging.${t.name} ${filter}
       ON CONFLICT (${conflictCols.join(", ")}) ${action};`;

  if (mirror) {
    const idCol = conflictCols[0];
    // ONE transaction so a crash can't leave dev half-synced: delete orphans FIRST (frees the
    // colliding alias/system values held by divergent dev rows), upsert prod rows by PK, realign the
    // serial (is_called=true ⇒ next nextval = max+1). id is NOT NULL so `NOT IN` is safe.
    exec(
      devUrl,
      `BEGIN;
       DELETE FROM public.${t.name}
         WHERE ${idCol} NOT IN (SELECT ${idCol} FROM sync_staging.${t.name});
       ${upsert}
       SELECT setval(pg_get_serial_sequence('public.${t.name}', '${idCol}'),
                     GREATEST((SELECT max(${idCol}) FROM public.${t.name}), 1), true);
       COMMIT;
       DROP TABLE sync_staging.${t.name};`,
    );
  } else {
    exec(
      devUrl,
      `${upsert}
     DROP TABLE sync_staging.${t.name};`,
    );
  }

  return { table: t.name, rows };
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  const prodUrl = process.env.PG_PROD_RO_DATABASE_URL;
  const devUrl = process.env.LIVEONE_DEV_DATABASE_URL;
  if (!prodUrl)
    throw new Error("set PG_PROD_RO_DATABASE_URL (read-only prod role)");
  if (!devUrl) throw new Error("set LIVEONE_DEV_DATABASE_URL (dev write role)");

  // Fail-closed: never let the WRITE target be prod. dev and prod share a host
  // (PlanetScale regional gateway), so compare the branch-encoding USERNAME, not
  // the host: identical users ⇒ same branch ⇒ refuse.
  const devUser = userOf(devUrl);
  const prodUser = userOf(prodUrl);
  const prodToken = (
    process.env.PLANETSCALE_PROD_BRANCH_ID ?? ""
  ).toLowerCase();
  if (devUser && devUser === prodUser) {
    throw new Error(
      "refusing to run: LIVEONE_DEV_DATABASE_URL and PG_PROD_RO_DATABASE_URL resolve to the same branch/role",
    );
  }
  if (prodToken && devUrl.toLowerCase().includes(prodToken)) {
    throw new Error(
      `refusing to run: dev write target carries the production identifier (${prodToken})`,
    );
  }

  console.log(
    `Sync prod → dev  (write target: ${devUser || "?"}@${hostOf(devUrl) || "?"})`,
  );
  const scratch = mkdtempSync(join(tmpdir(), "liveone-sync-"));
  const started = Date.now();
  try {
    for (const t of MANIFEST) {
      const { table, rows } = syncTable(prodUrl, devUrl, scratch, t);
      console.log(`  ${rows.toString().padStart(8)}  ${table}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    `✓ Sync complete in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
