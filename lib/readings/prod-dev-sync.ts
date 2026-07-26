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
 * Verifies that the synced tables share the same columns, constraints, and
 * indexes before the first write.
 */

import { Client } from "pg";
import { pipeline } from "node:stream/promises";
import { to as copyTo, from as copyFrom } from "pg-copy-streams";
import {
  armSocketForensics,
  formatConnectionPath,
  probeConnectionPath,
  reportBackendDrift,
} from "@/lib/db/planetscale/connection-forensics";

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
  // Additional unique keys that can identify a different dev row than conflictCols.
  // Delete only those colliding rows before the upsert so staged prod config wins.
  replaceConflicts?: string[][];
  excludeCols?: string[]; // drop the surrogate id so dev keeps/assigns its own
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

export interface SyncProdToDevOptions {
  prodUrl: string;
  devUrl: string;
  prodBranchId?: string;
  onProgress?: (message: string) => void;
}

// Small config tables — full refresh, FK parents first.
const FULL: FullTable[] = [
  { name: "systems", mode: "full", onConflict: "update" },
  // dashboards' uuid PK is minted independently by each environment's own config-transform run at
  // cutover, so dev and prod hold different uuids for "the same" dashboard (matched only by the frozen
  // legacy_id). A plain by-PK upsert would leave dev's own (divergent) row in place and never touch it,
  // and any FK that copies verbatim afterward (users.default_dashboard_id, share_tokens.dashboard_id)
  // would reference a prod uuid absent from dev. `idDrift` makes dev ADOPT prod's uuid: clear the dev
  // row colliding on legacy_id (or on owner+slug for legacy_id=NULL rows) before the by-PK upsert. Every
  // FK to dashboards.id is CASCADE/SET NULL (users, share_tokens, dashboard_grants, dashboard_revisions),
  // so no manual child clears are needed (children: []). Runs FIRST of the FK-bearing full tables so
  // users/share_tokens (synced next) land on uuids that already exist in dev.
  {
    name: "dashboards",
    mode: "full",
    onConflict: "update",
    idDrift: {
      uniqueKeys: [
        ["legacy_id"], // dashboards_legacy_id_unique
        ["owner_user_id", "slug"], // dashboards_owner_alias_unique
      ],
      children: [],
    },
  },
  ...["users", "user_systems", "polling_status", "share_tokens", "roles"].map(
    (name): FullTable => ({ name, mode: "full", onConflict: "update" }),
  ),
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
        ["owner_user_id", "slug"], // areas_owner_alias_unique — config-v4 renamed owner_clerk_user_id/alias
      ],
      children: [
        { table: "area_devices", cols: ["area_id"] },
        { table: "area_bindings", cols: ["area_id"] },
        { table: "point_readings_flow_attr_1d", cols: ["area_id"] },
        { table: "battery_provenance_daily", cols: ["area_id"] },
        { table: "device_trackers", cols: ["area_id"] },
        { table: "device_run_periods", cols: ["area_id"] },
        // config-v4 migration 0033 added this table (with an area_id FK, no ON DELETE) after this
        // children list was written, so it was never accounted for. Not itself in the sync manifest
        // (it's a frozen-at-cutover compat shim, not prod-mirrored data), so a cleared row isn't
        // restored by a later leg — same disposable-mirror tradeoff as device_run_periods above.
        { table: "legacy_handles", cols: ["area_id"] },
        // NOT handled here (2026-07-26 finding, deliberately out of scope): the config-v4 dark
        // v4-registry mirror (devices/points/derivations/derived_intervals, migration 0035) is
        // populated on dev by a SEPARATE script (registry-sync.ts), not this sync, so it isn't safe to
        // clear-and-abandon the way the other children above are. devices.primary_area_id /
        // derivations.area_id are NOT NULL/RESTRICT, so a real (post-cutover) drifted area with a
        // device blocks this delete — AND area_bindings.point_uid (dark, unconsumed by the app) can
        // cross-reference a point owned by a device under a DIFFERENT, non-drifted area, so naively
        // deleting devices/points here would also destroy live area_bindings rows for unrelated areas.
        // Needs its own considered fix (repair via registry-sync.ts re-run, or a null-out-not-delete
        // repair for the dark point_uid column) — see the areas-idDrift-devices follow-up.
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
        ["rid"], // pi_rid_unique (system-independent; config-v4 Phase 2) — dev adopts prod's rid,
        // so clear any dev row holding an incoming prod rid before the by-PK upsert (like point_uid)
      ],
      children: [
        // config-v4 CUTOVER SHAPE: the three hot stores now key on the internal point_rid (FK→points.rid),
        // so id-drift cleanup clears them by point_rid rather than the retired (system_id, point_id).
        { table: "point_readings_agg_5m", cols: ["point_rid"] },
        { table: "point_readings_agg_1d", cols: ["point_rid"] },
        { table: "point_readings", cols: ["point_rid"] },
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
    // Phase 4 added a second identity for a binding's ordered slot. A point can
    // move priority while dev still has another point in that slot; ON CONFLICT
    // can nominate only one unique index, so clear the other collision first.
    replaceConflicts: [["area_id", "role", "metric_type", "priority"]],
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
    // config-v4 CUTOVER SHAPE: the twin's natural PK is (point_rid, measurement_time) and it has no serial id.
    name: "point_readings",
    mode: "incremental",
    watermark: "created_at",
    overlap: "2 hours",
    onConflict: "nothing",
    conflictCols: ["point_rid", "measurement_time"], // point_readings_new_pkey
    // Correlated EXISTS, NOT `IN (SELECT id FROM sessions)`: the top-level `OR session_id IS NULL` blocks a
    // hash semijoin, so an uncorrelated IN degrades to a per-row scan of a materialised ~1M-row sessions set
    // (plan cost ~370M → ~20 min for an ~8k-row delta — this was the whole sync's bottleneck). EXISTS keys
    // each probe off sessions_pkey (cost ~21k, milliseconds). Same FK guard: keep readings whose session is
    // NULL or present; the rest re-sync next run once `sessions` (copied just before) catches up.
    filter:
      "(session_id IS NULL OR EXISTS (SELECT 1 FROM public.sessions se WHERE se.id = session_id))",
  },
  {
    // config-v4: cutover-invariant — no explicit conflictCols, so onConflict:"update" uses pkOf() (now
    // (point_rid, interval_end)/(point_rid, day)) and columnsOf() follows the twin, both at runtime.
    name: "point_readings_agg_5m",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 hours",
    onConflict: "update",
  },
  {
    // config-v4: cutover-invariant — no explicit conflictCols, so onConflict:"update" uses pkOf() (now
    // (point_rid, interval_end)/(point_rid, day)) and columnsOf() follows the twin, both at runtime.
    name: "point_readings_agg_1d",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
  },
  // Derived per-(area, day) tables materialised by the engine, NOT recomputed on dev (crons off), so
  // dev/preview only has them if we copy them. flow_attr_1d is the attributed matrix the Sankey +
  // provenance-summary read (the sole flow matrix since flow_1d was retired); battery_provenance_daily
  // powers the Battery-Contents card + daily provenance panels. Both keyed by updated_at, both idDrift
  // children of `areas` (cleared + re-populated here on a uuid realign, bounded by the overlap — see
  // areas.idDrift).
  //
  // FK safety vs snapshot skew: `areas` is copied minutes earlier in the run (separate snapshot), so a
  // transient areas idDrift/ordering gap can stage a row referencing an area not yet in dev — which would
  // abort the WHOLE sync (the 2026-07-17 failure). Skip those rows (`area_id IN (SELECT id FROM
  // public.areas)`); they re-sync next run within the overlap. `areas` is tiny, so this is trivial.
  {
    name: "point_readings_flow_attr_1d",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
    filter: "area_id IN (SELECT id FROM public.areas)", // FK safety — see the comment above
  },
  {
    name: "battery_provenance_daily",
    mode: "incremental",
    watermark: "updated_at",
    overlap: "2 days",
    onConflict: "update",
    filter: "area_id IN (SELECT id FROM public.areas)", // FK safety — see the comment above
  },
];

const MANIFEST: Table[] = [...FULL, ...INCREMENTAL];

/** Read-only manifest view used by the operational regression suite. */
export function prodDevSyncManifest(): readonly Table[] {
  return MANIFEST;
}

// ── connection + catalog helpers ────────────────────────────────────────────

/** disable-ish ssl signal (DB_SSL or a URL `sslmode`): "disable" / "false" / "0" / "disabled". */
function isSslDisabled(value: string | null | undefined): boolean {
  return ["0", "false", "disable", "disabled"].includes(
    (value ?? "").toLowerCase(),
  );
}

// A `pg.Client` with no 'error' listener CRASHES THE WHOLE PROCESS on a socket-level error
// (ECONNRESET, a dropped TLS session, …) — Node's default behaviour for an unhandled EventEmitter
// 'error' event — bypassing the FAIL HARD design entirely: that's a raw uncaught exception, not a
// query rejection, so the careful per-table try/catch (ROLLBACK before rethrow, clean top-level
// handling) never runs. A transient network blip (this is a cross-Pacific connection held open for
// the whole run) then looks identical to a real bug in the crash log. Attaching a listener is the
// standard node-postgres fix: it stops the crash, and the in-flight query/COPY promise still
// rejects from the same root cause (or the next query does, against the now-dead connection) —
// which the existing FAIL HARD path already handles normally.
function attachErrorHandler(client: Client, label: string): Client {
  client.on("error", (err) => {
    console.error(`[sync] connection error on ${label}:`, err);
  });
  return client;
}

// Build a pg Client the same way the app's pool does (lib/db/planetscale): parse
// the URL and set TLS EXPLICITLY, because node-postgres' bundled
// pg-connection-string can't handle PlanetScale's `sslrootcert=system` (it tries
// to open('system') as a file → ENOENT and the connection dies). Managed Postgres
// here connects encrypted-without-strict-CA; `sslmode=disable`/`DB_SSL=disable`
// still opts out for a local plaintext server.
function makeClient(url: string, label: string): Client {
  try {
    const u = new URL(url);
    const sslDisabled =
      isSslDisabled(u.searchParams.get("sslmode")) ||
      isSslDisabled(process.env.DB_SSL);
    for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) {
      u.searchParams.delete(p);
    }
    return attachErrorHandler(
      new Client({
        connectionString: u.toString(),
        ssl: sslDisabled ? false : { rejectUnauthorized: false },
      }),
      label,
    );
  } catch {
    // Not a parseable URL — hand it to pg as-is and let it surface the error.
    return attachErrorHandler(new Client({ connectionString: url }), label);
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

async function schemaSignatures(
  client: Client,
  tables: string[],
): Promise<string[]> {
  const res = await client.query(
    `SELECT table_name, signature
       FROM (
         SELECT cols.table_name,
                ('column:' || json_build_array(
                  cols.column_name,
                  cols.data_type,
                  cols.udt_schema,
                  cols.udt_name,
                  cols.is_nullable,
                  cols.column_default,
                  cols.identity_generation,
                  cols.is_generated,
                  cols.generation_expression
                )::text) AS signature
           FROM information_schema.columns cols
          WHERE cols.table_schema = 'public'
            AND cols.table_name = ANY($1)
         UNION ALL
         SELECT rel.relname AS table_name,
                ('constraint:' || json_build_array(
                  con.conname,
                  con.contype,
                  pg_get_constraintdef(con.oid, true)
                )::text) AS signature
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE ns.nspname = 'public'
            AND rel.relname = ANY($1)
         UNION ALL
         SELECT indexes.tablename AS table_name,
                ('index:' || json_build_array(
                  indexes.indexname,
                  indexes.indexdef
                )::text) AS signature
           FROM pg_indexes indexes
          WHERE indexes.schemaname = 'public'
            AND indexes.tablename = ANY($1)
       ) schema_items
      ORDER BY table_name, signature`,
    [tables],
  );
  return res.rows.map((row) => `${row.table_name}:${row.signature}`);
}

/** Fail before staging any data when prod and dev do not share the sync schema. */
export async function assertManifestSchemaParity(
  prod: Client,
  dev: Client,
  tables: string[] = MANIFEST.map((table) => table.name),
): Promise<void> {
  const [prodSchema, devSchema] = await Promise.all([
    schemaSignatures(prod, tables),
    schemaSignatures(dev, tables),
  ]);
  const prodSet = new Set(prodSchema);
  const devSet = new Set(devSchema);
  const prodOnly = prodSchema.filter((item) => !devSet.has(item));
  const devOnly = devSchema.filter((item) => !prodSet.has(item));
  if (prodOnly.length || devOnly.length) {
    const summarize = (items: string[]) =>
      items.length ? items.slice(0, 3).join("; ") : "none";
    throw new Error(
      `prod/dev schema mismatch for sync manifest (prod-only: ${summarize(prodOnly)}; dev-only: ${summarize(devOnly)})`,
    );
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

export async function syncTable(
  prod: Client,
  dev: Client,
  t: Table,
  colsByTable: Map<string, string[]>,
  pkByTable: Map<string, string[]>,
): Promise<{ table: string; rows: number }> {
  const exclude = new Set((t as IncrementalTable).excludeCols ?? []);
  const cols = (colsByTable.get(t.name) ?? []).filter((c) => !exclude.has(c));
  if (cols.length === 0)
    throw new Error(`no columns found for ${t.name} (schema mismatch?)`);
  const colList = cols.join(", ");

  const pk = pkByTable.get(t.name) ?? [];
  const conflictCols = (t as IncrementalTable).conflictCols ?? pk;
  if (conflictCols.length === 0)
    throw new Error(`no conflict key for ${t.name}`);

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
  const replaceConflicts = t.mode === "full" ? t.replaceConflicts : undefined;

  // 3. Upsert into dev. The transaction paths ROLLBACK before rethrowing so a failure
  // never leaves the persistent dev connection stuck in an aborted transaction.
  try {
    if (idDrift) {
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
    } else if (replaceConflicts?.length) {
      const match = replaceConflicts
        .map(
          (key) => "(" + key.map((c) => `d.${c} = s.${c}`).join(" AND ") + ")",
        )
        .join(" OR ");
      const sameConflict = conflictCols
        .map((c) => `d.${c} = s.${c}`)
        .join(" AND ");
      // Keep dev-only config generally, but an incoming prod row must own every
      // unique key it carries. Do the collision cleanup and upsert atomically.
      await dev.query(
        `BEGIN;
       DELETE FROM public.${t.name} d
         USING sync_staging.${t.name} s
         WHERE (${match}) AND NOT (${sameConflict});
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

export async function syncProdToDev(options: SyncProdToDevOptions): Promise<{
  tables: Array<{ table: string; rows: number; elapsedMs: number }>;
  elapsedMs: number;
}> {
  const { prodUrl, devUrl } = options;
  const log = options.onProgress ?? console.log;
  // Fail-closed: never let the WRITE target be prod. dev and prod share a host
  // (PlanetScale regional gateway), so compare the branch-encoding USERNAME, not
  // the host: identical users ⇒ same branch ⇒ refuse.
  const devUser = userOf(devUrl);
  const prodUser = userOf(prodUrl);
  const prodToken = (options.prodBranchId ?? "").toLowerCase();
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

  log(
    `Sync prod → dev  (write target: ${devUser || "?"}@${hostOf(devUrl) || "?"})`,
  );

  // Two persistent connections for the whole run (see TRANSPORT in the header).
  const prod = makeClient(prodUrl, "prod");
  const dev = makeClient(devUrl, "dev");
  await prod.connect();
  await dev.connect();

  // Dropout forensics (docs/incidents/2026-07-25-prod-dev-sync-connection-dropouts.md).
  // Arm AFTER connect — pg only creates the socket then. Both are fail-safe.
  const prodProbe = armSocketForensics(prod, "sync:prod", log);
  const devProbe = armSocketForensics(dev, "sync:dev", log);
  const prodPath = await probeConnectionPath(prod, prodUrl);
  const devPath = await probeConnectionPath(dev, devUrl);
  if (prodPath) log(`[sync:prod] conn-path ${formatConnectionPath(prodPath)}`);
  if (devPath) log(`[sync:dev] conn-path ${formatConnectionPath(devPath)}`);

  const started = Date.now();
  const tables: Array<{ table: string; rows: number; elapsedMs: number }> = [];
  try {
    // Columns + PK for every table, batched from the dev catalog (both DBs share the schema).
    const names = MANIFEST.map((t) => t.name);
    prodProbe.setPhase("schema parity read");
    devProbe.setPhase("schema parity + catalog read");
    await assertManifestSchemaParity(prod, dev, names);
    const colsByTable = await columnsOf(dev, names);
    const pkByTable = await pkOf(dev, names);

    for (const t of MANIFEST) {
      const t0 = Date.now();
      // Phase granularity is per-table, not per-statement: the point is to separate a
      // death DURING a table's work from one while the client sat idle waiting for the
      // other side (prod idles through every dev-side upsert, and vice-versa).
      prodProbe.setPhase(`${t.name}: COPY OUT, then idle`);
      devProbe.setPhase(`${t.name}: stage + upsert`);
      const { table, rows } = await syncTable(
        prod,
        dev,
        t,
        colsByTable,
        pkByTable,
      );
      prodProbe.setPhase(`idle after ${t.name}`);
      devProbe.setPhase(`idle after ${t.name}`);
      const elapsedMs = Date.now() - t0;
      tables.push({ table, rows, elapsedMs });
      const secs = (elapsedMs / 1000).toFixed(1);
      // Per-table timing: makes a slow leg obvious in the Actions log (and pairs with the
      // workflow's >5-min Slack warning). point_readings used to dominate at ~20 min; see its filter.
      log(
        `  ${rows.toString().padStart(8)}  ${table.padEnd(30)} ${secs.padStart(7)}s`,
      );
    }
    const elapsedMs = Date.now() - started;
    // Success path only: on failure the connection is usually already gone.
    await reportBackendDrift(prod, "sync:prod", prodPath, log);
    await reportBackendDrift(dev, "sync:dev", devPath, log);
    log(`✓ Sync complete in ${(elapsedMs / 1000).toFixed(1)}s`);
    return { tables, elapsedMs };
  } finally {
    // No "expected close" flag here on purpose: on a real dropout the query rejects a
    // tick before this runs, so setting one would suppress the very report we need.
    // armSocketForensics reads pg's own `_ending` at distress time instead.
    await prod.end().catch(() => {});
    await dev.end().catch(() => {});
  }
}
