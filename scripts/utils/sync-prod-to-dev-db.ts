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
 * TRANSPORT — why this is fast: it holds exactly TWO persistent `pg` connections
 * for the whole run (one read-only prod, one dev-write) and streams each table
 * `COPY (SELECT …) TO STDOUT` (prod) → `COPY sync_staging.<t> FROM STDIN` (dev)
 * over them. No `psql`, no temp files. The DB is in Sydney and CI runs
 * cross-Pacific, so a fresh connection costs ~1s of TCP+TLS+auth; the previous
 * psql-per-operation design paid that ~8×/table × 19 tables ≈ 150 times (~190s of
 * pure handshakes, independent of row count). Two connections pays it twice.
 *
 * FAIL HARD: any query rejection (a bad statement, a COPY constraint violation, a
 * broken stream) propagates to the top-level handler → `process.exit(1)`. Nothing
 * is swallowed. The per-table transaction paths ROLLBACK before rethrowing.
 *
 * Assumes liveone-dev shares prod's schema (true right after an R2 restore).
 */

import { Client } from "pg";
import { pipeline } from "node:stream/promises";
import { to as copyTo, from as copyFrom } from "pg-copy-streams";

// ── Manifest ────────────────────────────────────────────────────────────────

// An FK child of an idDrift parent: `cols` are the child's FK columns, mapped POSITIONALLY onto the
// parent's PK columns (e.g. parent point_info PK = (system_id, id); area_bindings' (point_system_id,
// point_id) references it). Children don't all ON DELETE CASCADE, so id-drift clears them by hand.
type FkChild = { table: string; cols: string[] };

// Resolve a divergent-surrogate collision that the natural-key trick (excludeCols) CAN'T fix because
// the surrogate PK is itself the FK-join key children carry — so dev must ADOPT prod's PK, not keep its
// own. When dev already holds the same logical row under a DIFFERENT PK, the by-PK upsert trips a
// SECONDARY unique index and aborts the whole sync. Before the upsert we delete the mismatched dev rows
// (matched on any of `uniqueKeys`, different PK) and their `children`, so prod's rows land; later
// manifest steps (full-refresh parents + incremental readings) re-populate the children under the new
// PKs. Works for composite (point_info) and single-uuid (areas) PKs alike.
//
// Caveat: idDrift clears a realigned parent's FK children, which their own later manifest legs then
// re-populate — but the flow/agg/provenance children re-sync INCREMENTALLY (bounded by the watermark
// overlap), so a drifted area's rows OLDER than that window aren't restored until a full R2 restore.
// device_run_periods is recomputed on dev (db:recompute-dev-runs), not synced. Fine for a disposable
// mirror; the realigning rows are few (an occasional independently-created area / renumbered helper point).
type IdDrift = {
  uniqueKeys: string[][]; // secondary unique indexes (each a full column list) a divergent-PK row collides on
  children: FkChild[];
};

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
  idDrift?: IdDrift; // clear divergent-id collisions before the by-PK upsert (see IdDrift)
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
    "users",
    "user_systems",
    "polling_status",
    "share_tokens",
    "roles",
  ].map((name): FullTable => ({ name, mode: "full", onConflict: "update" })),
  // areas' uuid PK is generated independently on dev, so dev can hold the same logical Area (same
  // legacy_system_id / owner+alias) under a different uuid. The by-PK upsert then trips a secondary
  // unique index (areas_legacy_system_unique / areas_owner_alias_unique). `idDrift` clears the mismatched
  // dev Area (+ its FK children) so prod's uuid lands. FK-first: areas here, then area_devices /
  // area_bindings / the incremental flow legs re-populate under the correct uuid.
  {
    name: "areas",
    mode: "full",
    onConflict: "update",
    idDrift: {
      uniqueKeys: [
        ["legacy_system_id"], // areas_legacy_system_unique
        ["owner_clerk_user_id", "alias"], // areas_owner_alias_unique
      ],
      children: [
        { table: "area_devices", cols: ["area_id"] },
        { table: "area_bindings", cols: ["area_id"] },
        { table: "point_readings_flow_1d", cols: ["area_id"] },
        { table: "point_readings_flow_attr_1d", cols: ["area_id"] },
        { table: "battery_provenance_daily", cols: ["area_id"] },
        { table: "device_trackers", cols: ["area_id"] },
        { table: "device_run_periods", cols: ["area_id"] },
      ],
    },
  },
  // point_info's serial `id` is BOTH assigned independently on dev AND the FK-join key every readings
  // row carries — so, unlike area_bindings, dev must ADOPT prod's id (can't exclude it). When dev holds
  // the same logical point under a different id (e.g. derived helper points numbered in a different
  // order), the by-PK upsert trips one of point_info's THREE secondary unique indexes and aborts the
  // whole sync. `idDrift` clears those blockers (and their FK children) first. FK-first: point_info
  // here, then area_bindings, then the incremental readings legs re-sync the children.
  {
    name: "point_info",
    mode: "full",
    onConflict: "update",
    idDrift: {
      uniqueKeys: [
        ["system_id", "physical_path_tail"], // pi_system_physical_path_unique
        ["system_id", "logical_path_stem", "metric_type"], // pi_system_stem_metric_unique
        ["point_uid"], // pi_point_uid_unique (system-independent)
      ],
      children: [
        { table: "point_readings_agg_5m", cols: ["system_id", "point_id"] },
        { table: "point_readings_agg_1d", cols: ["system_id", "point_id"] },
        { table: "point_readings", cols: ["system_id", "point_id"] },
        { table: "area_bindings", cols: ["point_system_id", "point_id"] },
        {
          table: "device_trackers",
          cols: ["signal_system_id", "signal_point_id"],
        },
        {
          table: "device_run_periods",
          cols: ["signal_system_id", "signal_point_id"],
        },
      ],
    },
  },
  // area→device membership. Natural composite PK (area_id, system_id) — no surrogate — so a plain by-PK
  // full upsert. After areas (FK parent) so a realigned Area re-gets its prod membership.
  { name: "area_devices", mode: "full", onConflict: "update" },
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
    // Correlated EXISTS, NOT `IN (SELECT id FROM sessions)`: the top-level `OR session_id IS NULL` blocks a
    // hash semijoin, so an uncorrelated IN degrades to a per-row scan of a materialised ~1M-row sessions set
    // (plan cost ~370M → ~20 min for an ~8k-row delta — this was the whole sync's bottleneck). EXISTS keys
    // each probe off sessions_pkey (cost ~21k, milliseconds). Same FK guard: keep readings whose session is
    // NULL or present; the rest re-sync next run once `sessions` (copied just before) catches up.
    filter:
      "(session_id IS NULL OR EXISTS (SELECT 1 FROM public.sessions se WHERE se.id = session_id))",
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
    // FK safety vs snapshot skew: `areas` is copied minutes earlier in the run (separate snapshot), so a
    // transient areas idDrift/ordering gap can stage a flow row referencing an area not yet in dev — which
    // aborts the WHOLE sync (the 2026-07-17 failure). Skip those rows, like point_readings skips
    // session-less readings; they re-sync next run within the overlap. `areas` is tiny, so this is trivial.
    filter: "area_id IN (SELECT id FROM public.areas)",
  },
  // Derived per-(area, day) tables, same class as flow_1d: materialised by the engine, NOT recomputed
  // on dev (crons off), so dev/preview only has them if we copy them. flow_attr_1d is the attributed
  // superset the modern Sankey + provenance-summary read; battery_provenance_daily powers the
  // Battery-Contents card + daily provenance panels. Both keyed by updated_at, both idDrift children of
  // `areas` (cleared + re-populated here on a uuid realign, bounded by the overlap — see areas.idDrift).
  {
    name: "point_readings_flow_attr_1d",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
    filter: "area_id IN (SELECT id FROM public.areas)", // FK safety — see point_readings_flow_1d
  },
  {
    name: "battery_provenance_daily",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
    filter: "area_id IN (SELECT id FROM public.areas)", // FK safety — see point_readings_flow_1d
  },
];

const MANIFEST: Table[] = [...FULL, ...INCREMENTAL];

// ── connection + catalog helpers ────────────────────────────────────────────

/** disable-ish ssl signal (DB_SSL or a URL `sslmode`): "disable" / "false" / "0" / "disabled". */
function isSslDisabled(value: string | null | undefined): boolean {
  return ["0", "false", "disable", "disabled"].includes(
    (value ?? "").toLowerCase(),
  );
}

// Build a pg Client the same way the app's pool does (lib/db/planetscale): parse
// the URL and set TLS EXPLICITLY, because node-postgres' bundled
// pg-connection-string can't handle PlanetScale's `sslrootcert=system` (it tries
// to open('system') as a file → ENOENT and the connection dies). Managed Postgres
// here connects encrypted-without-strict-CA; `sslmode=disable`/`DB_SSL=disable`
// still opts out for a local plaintext server.
function makeClient(url: string): Client {
  try {
    const u = new URL(url);
    const sslDisabled =
      isSslDisabled(u.searchParams.get("sslmode")) ||
      isSslDisabled(process.env.DB_SSL);
    for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) {
      u.searchParams.delete(p);
    }
    return new Client({
      connectionString: u.toString(),
      ssl: sslDisabled ? false : { rejectUnauthorized: false },
    });
  } catch {
    // Not a parseable URL — hand it to pg as-is and let it surface the error.
    return new Client({ connectionString: url });
  }
}

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

// Column order + PK for every manifest table, in ONE query each, from the DEST
// (dev) catalog — both DBs share the schema. Batched (not per-table) because even
// on a persistent connection each round trip is a ~200ms cross-Pacific hop.
async function columnsOf(
  client: Client,
  tables: string[],
): Promise<Map<string, string[]>> {
  const res = await client.query(
    `SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS cols
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name = ANY($1)
       GROUP BY table_name`,
    [tables],
  );
  const m = new Map<string, string[]>();
  for (const r of res.rows) m.set(r.table_name, String(r.cols).split(","));
  return m;
}

async function pkOf(
  client: Client,
  tables: string[],
): Promise<Map<string, string[]>> {
  const res = await client.query(
    `SELECT c.relname AS t,
            string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum)) AS pk
       FROM pg_index i
       JOIN pg_class c     ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE n.nspname='public' AND i.indisprimary AND c.relname = ANY($1)
       GROUP BY c.relname`,
    [tables],
  );
  const m = new Map<string, string[]>();
  for (const r of res.rows) m.set(r.t, String(r.pk).split(","));
  return m;
}

// ── per-table sync ────────────────────────────────────────────────────────────

async function syncTable(
  prod: Client,
  dev: Client,
  t: Table,
  colsByTable: Map<string, string[]>,
  pkByTable: Map<string, string[]>,
): Promise<{ table: string; rows: number }> {
  const mirror = t.mode === "full" && t.mirror === true; // narrows t to FullTable
  const exclude = new Set(
    mirror ? [] : ((t as IncrementalTable).excludeCols ?? []),
  );
  const cols = (colsByTable.get(t.name) ?? []).filter((c) => !exclude.has(c));
  if (cols.length === 0)
    throw new Error(`no columns found for ${t.name} (schema mismatch?)`);
  const colList = cols.join(", ");

  const pk = pkByTable.get(t.name) ?? [];
  const conflictCols = mirror
    ? pk
    : ((t as IncrementalTable).conflictCols ?? pk);
  if (conflictCols.length === 0)
    throw new Error(`no conflict key for ${t.name}`);
  if (mirror && pk.length !== 1)
    throw new Error(
      `mirror ${t.name} requires a single-column PK (got ${pk.length})`,
    );

  // Source predicate: incremental ⇒ rows newer than (dev max − overlap). Read the
  // watermark HERE (lazily, per table), not batched up front, because the full leg
  // that runs before the incremental leg can idDrift-delete rows from these tables —
  // the watermark must reflect the post-delete max so the deleted children re-sync.
  let predicate = "";
  if (t.mode === "incremental") {
    const wmRes = await dev.query(
      `SELECT (max(${t.watermark}) - interval '${t.overlap}')::text AS wm FROM public.${t.name}`,
    );
    const wm = wmRes.rows[0]?.wm as string | null;
    if (wm) predicate = `WHERE ${t.watermark} > '${wm}'`;
  }

  // 1. Stage on dev. `LIKE` (no defaults) keeps the staging table from burning the
  // real serial sequence; drop NOT NULL on excluded cols so the partial COPY (which
  // omits them) doesn't trip a NOT NULL constraint.
  const dropNotNull = [...exclude]
    .map(
      (c) =>
        `ALTER TABLE sync_staging.${t.name} ALTER COLUMN ${c} DROP NOT NULL;`,
    )
    .join(" ");
  await dev.query(
    `CREATE SCHEMA IF NOT EXISTS sync_staging;
     DROP TABLE IF EXISTS sync_staging.${t.name};
     CREATE UNLOGGED TABLE sync_staging.${t.name} (LIKE public.${t.name}); ${dropNotNull}`,
  );

  // 2. Stream the delta prod → dev over the wire: COPY … TO STDOUT (read-only prod)
  // piped straight into COPY … FROM STDIN (dev staging). Default COPY text format →
  // faithful NULLs (\N), same fidelity as the old file-based \copy. Backpressure and
  // errors propagate through pipeline() (a rejection here fails the whole run).
  const source = prod.query(
    copyTo(
      `COPY (SELECT ${colList} FROM public.${t.name} ${predicate}) TO STDOUT`,
    ),
  );
  const dest = dev.query(
    copyFrom(`COPY sync_staging.${t.name} (${colList}) FROM STDIN`),
  );
  await pipeline(source, dest);
  const rows = dest.rowCount ?? 0;

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

  const idDrift = t.mode === "full" ? t.idDrift : undefined;

  // 3. Upsert into dev. The transaction paths ROLLBACK before rethrowing so a failure
  // never leaves the persistent dev connection stuck in an aborted transaction.
  try {
    if (mirror) {
      const idCol = conflictCols[0];
      // ONE transaction so a crash can't leave dev half-synced: delete orphans FIRST (frees the
      // colliding alias/system values held by divergent dev rows), upsert prod rows by PK, realign the
      // serial (is_called=true ⇒ next nextval = max+1). id is NOT NULL so `NOT IN` is safe.
      await dev.query(
        `BEGIN;
       DELETE FROM public.${t.name}
         WHERE ${idCol} NOT IN (SELECT ${idCol} FROM sync_staging.${t.name});
       ${upsert}
       SELECT setval(pg_get_serial_sequence('public.${t.name}', '${idCol}'),
                     GREATEST((SELECT max(${idCol}) FROM public.${t.name}), 1), true);
       COMMIT;
       DROP TABLE sync_staging.${t.name};`,
      );
    } else if (idDrift) {
      // Same-logical-row-different-PK: dev rows sharing ANY secondary unique key with a staged prod row
      // but sitting under a different PK. Whichever key collides would abort the by-PK upsert, so clear
      // them (and their FK children — not all ON DELETE CASCADE) inside the upsert's transaction. `_drift`
      // carries the parent's PK columns; children map their FK columns positionally onto that PK.
      const match = idDrift.uniqueKeys
        .map(
          (key) => "(" + key.map((c) => `d.${c} = s.${c}`).join(" AND ") + ")",
        )
        .join(" OR ");
      const samePk = pk.map((c) => `d.${c} = s.${c}`).join(" AND ");
      const childDeletes = idDrift.children
        .map((c) => {
          const on = c.cols
            .map((col, i) => `x.${col} = b.${pk[i]}`)
            .join(" AND ");
          return `DELETE FROM public.${c.table} x USING _drift b WHERE ${on};`;
        })
        .join("\n       ");
      // ANALYZE _drift before the child DELETEs: it's a just-created temp table with no
      // stats, and on the normal (no-drift) run it's EMPTY. Without stats the planner
      // mis-estimates its cardinality and full-seq-scans the huge child tables
      // (point_readings ~13M, agg_5m ~3M) to find zero matches — ~40s/run for nothing.
      // Accurate stats ⇒ a trivial nested loop keyed off _drift (never scans the big
      // tables when empty; index-probes them when drift is genuinely present).
      await dev.query(
        `BEGIN;
       CREATE TEMP TABLE _drift ON COMMIT DROP AS
         SELECT DISTINCT ${pk.map((c) => `d.${c}`).join(", ")}
           FROM public.${t.name} d
           JOIN sync_staging.${t.name} s ON (${match})
          WHERE NOT (${samePk});
       ANALYZE _drift;
       ${childDeletes}
       DELETE FROM public.${t.name} d USING _drift b
         WHERE ${pk.map((c) => `d.${c} = b.${c}`).join(" AND ")};
       ${upsert}
       COMMIT;
       DROP TABLE sync_staging.${t.name};`,
      );
    } else {
      await dev.query(
        `${upsert}
     DROP TABLE sync_staging.${t.name};`,
      );
    }
  } catch (err) {
    // Leave the shared dev connection clean for the top-level handler's teardown.
    await dev.query("ROLLBACK").catch(() => {});
    throw err;
  }

  return { table: t.name, rows };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
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

  // Two persistent connections for the whole run (see TRANSPORT in the header).
  const prod = makeClient(prodUrl);
  const dev = makeClient(devUrl);
  await prod.connect();
  await dev.connect();

  const started = Date.now();
  try {
    // Columns + PK for every table, batched from the dev catalog (both DBs share the schema).
    const names = MANIFEST.map((t) => t.name);
    const colsByTable = await columnsOf(dev, names);
    const pkByTable = await pkOf(dev, names);

    for (const t of MANIFEST) {
      const t0 = Date.now();
      const { table, rows } = await syncTable(
        prod,
        dev,
        t,
        colsByTable,
        pkByTable,
      );
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      // Per-table timing: makes a slow leg obvious in the Actions log (and pairs with the
      // workflow's >5-min Slack warning). point_readings used to dominate at ~20 min; see its filter.
      console.log(
        `  ${rows.toString().padStart(8)}  ${table.padEnd(30)} ${secs.padStart(7)}s`,
      );
    }
    console.log(
      `✓ Sync complete in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } finally {
    await prod.end().catch(() => {});
    await dev.end().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
