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
// parent's PK columns (e.g. parent point_readings keys on point_rid, which references points.rid).
// Children don't all ON DELETE CASCADE, so id-drift clears them by hand. `point_info` has NO FK
// children left at all since migration 0047 (config-v4 Phase 12 slice E PR 2a) released
// `area_bindings`, the last one.
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
// derived_intervals is recomputed on dev (db:recompute-dev-runs), not synced. Fine for a disposable
// mirror; the realigning rows are few (an occasional independently-created area / renumbered helper point).
//
// `repoint` is the alternative to `children` for an FK that CANNOT be cleared: a NOT NULL / NO ACTION
// reference (devices.primary_area_id, derivations.area_id) blocks the parent DELETE outright. Those rows
// belong to the same LOGICAL parent, so they are MOVED onto prod's PK rather than deleted — which also
// avoids the trap that makes the delete-the-devices alternative unsafe: area_bindings.point_uid can
// reference a point owned by a device under a DIFFERENT, non-drifted area, so cascading from devices
// would destroy unrelated areas' live bindings. Repointing touches no devices/points rows at all.
//
// The repoint UPDATE needs prod's row to already exist (it is the FK target), but the drifted dev row
// blocks the upsert on a secondary unique index — so `neutralize` names the columns of those unique keys,
// made non-colliding first so both rows can coexist for the middle of the transaction. Ordering is
// therefore load-bearing: neutralize → upsert → repoint → delete.
// A CROSS-TABLE natural key: the discriminating value does not live on the drifting table at all, but on
// a satellite table that references it. `uniqueKeys` cannot express this — every entry there is a column
// list on the drifting table itself.
//
// Introduced by config-v4 Phase 13 PR 5, which removed `areas.legacy_system_id`. That column was the
// areas leg's cross-ENVIRONMENT identity (area uuids are minted per-environment, so they always differ),
// and the documented fallback `["owner_user_id", "slug"]` cannot replace it: measured on `liveone-dev`,
// **16 of 22 areas have a NULL slug** (and `reown-dev-data.ts` rewrites dev's `owner_user_id` besides).
// There is no on-table substitute either — `name` is not unique (2 duplicate pairs; `(owner, name)` is
// 20 distinct over 22 rows). The surviving identity is `legacy_handles.handle`, frozen at cutover and so
// identical in both environments. Losing it would leave the sync unable to detect drift for 73% of
// areas — **silently**, which is indistinguishable from a sync with nothing to do.
//
// Semantics: dev row `d` and staged prod row `s` are the same LOGICAL row when some row of dev's `table`
// points at `d`, some row of prod's `table` points at `s`, and the two agree on every `keyCols` column.
//
// Prod's satellite slice is staged into its OWN helper table (`sync_staging._xkey_<table>`) rather than
// reusing `sync_staging.<table>`, for two reasons: the satellite's own manifest leg has not run yet (and
// must not — it is an FK CHILD of the very table being realigned, so it is cleared and repopulated
// around this one), and the helper must not collide with that leg's later staging table.
type CrossKey = {
  table: string; // satellite table carrying the key, e.g. "legacy_handles"
  parentCol: string; // its FK onto the drifting table's (single-column) PK, e.g. "area_id"
  keyCols: string[]; // the cross-environment natural key, e.g. ["handle"]
};

type IdDrift = {
  uniqueKeys: string[][]; // secondary unique indexes (each a full column list) a divergent-PK row collides on
  // Cross-TABLE identities, OR-ed into the same match as `uniqueKeys` (see CrossKey). Only valid for a
  // single-column PK — the satellite carries one FK column per `parentCol`.
  crossKeys?: CrossKey[];
  children: FkChild[];
  repoint?: FkChild[]; // FKs that must FOLLOW the realignment instead of being deleted (NOT NULL/NO ACTION)
  // Columns of `uniqueKeys` freed on the drifted dev row so prod's row can be inserted alongside it.
  // A bare string NULLs the column (Postgres unique indexes permit multiple NULLs) — which only works
  // if it is nullable. `{ col, expr }` assigns an expression instead, for a NOT NULL key column where
  // there is nothing to NULL: `devices.rid` is NOT NULL, so the drifted row is pushed into a disjoint
  // value range rather than emptied. The neutralised row is DELETED moments later in the SAME
  // transaction, so the value never has to be restored or even meaningful — only collision-free.
  neutralize?: (string | { col: string; expr: string })[];
};

/**
 * Staging table for a cross-key satellite slice. Deliberately NOT `sync_staging.<table>`: the satellite
 * (`legacy_handles`) has its own manifest leg that stages under that exact name later in the run, and it
 * is an FK child of the table being realigned, so the two must not share a table.
 */
const crossKeyStaging = (ck: CrossKey): string =>
  `sync_staging._xkey_${ck.table}_${ck.parentCol}`;

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
  // `systems`, `polling_status` and `point_info` were dropped by migration 0051 (the Phase 12 terminal
  // window) and their legs are gone with them: `devices`/`device_state`/`points` are the live tables and
  // are already synced below. The manifest is not type-checked against the schema — a stale entry here
  // would fail at RUNTIME on the next dispatch, not at build.
  // dashboards' uuid PK is minted independently by each environment's own config-transform run at
  // cutover, so dev and prod can hold different uuids for "the same" dashboard. A plain by-PK upsert
  // would leave dev's own (divergent) row in place and never touch it, and any FK that copies verbatim
  // afterward (users.default_dashboard_id, share_tokens.dashboard_id) would reference a prod uuid
  // absent from dev. `idDrift` makes dev ADOPT prod's uuid: clear the colliding dev row before the
  // by-PK upsert. Every FK to dashboards.id is CASCADE/SET NULL (users, share_tokens,
  // dashboard_grants, dashboard_revisions — the latter DELIBERATELY unsynced: dev history is
  // dev-local, and this drift-delete + CASCADE wipes it, which is accepted), so no manual child
  // clears are needed (children: []). Runs
  // FIRST of the FK-bearing full tables so users/share_tokens (synced next) land on uuids that already
  // exist in dev.
  //
  // 🛑 `slug` is now the ONLY cross-environment identity, so EVERY dashboard must carry one. The
  // frozen `legacy_id` used to be the primary key here and was dropped (migration 0062) — the two
  // dashboards that had a NULL slug (Daylesford, Kew) were given one in the same change, precisely
  // because a NULL slug matches nothing (NULL = NULL is never true) and would have left those rows
  // with no correlation key at all. A new dashboard with a NULL slug is invisible to this drift
  // resolution: it will be adopted only if its uuid already agrees.
  {
    name: "dashboards",
    mode: "full",
    onConflict: "update",
    idDrift: {
      uniqueKeys: [
        ["owner_user_id", "slug"], // dashboards_owner_alias_unique
        // Not an index — the stable CROSS-ENVIRONMENT identity, and the only key that survives
        // reown-dev-data.ts having rewritten dev's owner_user_id (which is what defeats the pair
        // above). For a `legacy-share-*` dashboard the slug is derived from the share-token phrase
        // and so is identical in both environments; for the rest it is the shortname the owner set.
        ["slug"],
      ],
      children: [],
    },
  },
  ...["users", "share_tokens"].map(
    (name): FullTable => ({ name, mode: "full", onConflict: "update" }),
  ),
  // areas' uuid PK is generated independently on dev, so dev can hold the same logical Area (same
  // handle / owner+alias) under a different uuid. The by-PK upsert then trips a secondary
  // unique index (areas_owner_alias_unique). `idDrift` clears the mismatched
  // dev Area (+ its FK children) so prod's uuid lands. FK-first: areas here, then area_members /
  // area_bindings / the incremental flow legs re-populate under the correct uuid.
  {
    name: "areas",
    mode: "full",
    onConflict: "update",
    idDrift: {
      uniqueKeys: [
        ["owner_user_id", "slug"], // areas_owner_alias_unique — config-v4 renamed owner_clerk_user_id/alias
      ],
      // ⚠️ config-v4 Phase 13 PR 5 replaced the `["legacy_system_id"]` key with this cross-table one,
      // because the column is dropped in PR 6. `owner_user_id + slug` above CANNOT carry the leg alone:
      // 16 of 22 dev areas have a NULL slug (NULL = NULL never matches) and `reown-dev-data.ts` has
      // already rewritten dev's `owner_user_id`. `legacy_handles.handle` is frozen at cutover and so is
      // the one value identical in both environments — verified 22/22 on `liveone-dev`, with the
      // relation `areas(id, legacy_system_id)` set-identical to `legacy_handles(area_id, handle)` in
      // BOTH directions before the swap. See `CrossKey` for why prod's slice must be staged separately.
      crossKeys: [
        { table: "legacy_handles", parentCol: "area_id", keyCols: ["handle"] },
      ],
      children: [
        // `area_members` is deliberately NOT listed: its `area_id` FK is ON DELETE CASCADE, so a cleared
        // drifted area takes its membership with it, and the `area_members` leg below repopulates under
        // prod's uuid. (`area_devices` sat here until slice H dropped it.)
        { table: "area_bindings", cols: ["area_id"] },
        { table: "point_readings_flow_attr_1d", cols: ["area_id"] },
        { table: "battery_provenance_daily", cols: ["area_id"] },
        // config-v4 migration 0033 added this table (with an area_id FK, no ON DELETE) after this
        // children list was written, so it was never accounted for. Phase 12 slice A added it to the
        // manifest below (after `devices`, its other FK parent), so a cleared row IS now restored by a
        // later leg — it is an ordinary clear-and-repopulate child like the four above.
        { table: "legacy_handles", cols: ["area_id"] },
      ],
      // Both FKs below are NOT NULL / NO ACTION, so a post-cutover drifted area that owns a device
      // BLOCKS the parent delete outright: this is the failure that froze liveone-dev from
      // 2026-07-25 (`devices_primary_area_id_areas_id_fk`). They name the same
      // LOGICAL area as prod's incoming row, so they are MOVED onto prod's uuid instead of deleted.
      // derivations moved out of `children` for the same reason — repointing it also preserves its
      // derived_intervals (CASCADE, migration 0040) rather than forcing a recompute.
      repoint: [
        { table: "devices", cols: ["primary_area_id"] },
        { table: "derivations", cols: ["area_id"] },
      ],
      // Nullable columns behind areas_owner_alias_unique. Cleared on the drifted dev row so prod's row
      // can be inserted alongside it, which the repoint UPDATE needs as its FK target. The drifted row
      // is deleted moments later, in the same transaction.
      //
      // config-v4 Phase 13 PR 6 dropped `legacy_system_id` from this list with the column itself
      // (migration 0052) — `neutralize` emits a literal `UPDATE areas SET <col> = NULL`, so leaving it
      // here would be a runtime 42703 in the sync, invisible to tsc. Its index went too, which is why
      // the cross-table `crossKeys` above had to land FIRST (PR 5): while the column existed, an
      // undetected drift ABORTED on `areas_legacy_system_unique` and so was its own backstop; without
      // it the same miss is a silent no-op.
      neutralize: ["slug"],
    },
  },
  // ── config-v4 v4 registries (Phase 12 slice A) ──────────────────────────────
  // These were populated on dev by scripts/config-v4/registry-sync.ts — cutover scaffolding that Phase 12
  // DELETES — so without them here dev's registries freeze at the last manual run (they were 4 rows short
  // of the legacy membership table when this landed; slice H has since made `area_members` primary and
  // dropped that table). They are also no longer dark: point_readings and both agg
  // twins FK point_rid → points.rid, so a point minted on prod that never reaches dev's `points` breaks
  // the incremental readings legs outright — the same class of failure as the areas FK that froze dev for
  // three days. FK order within the group: devices (→ areas) → everything else (→ devices).
  {
    name: "devices",
    mode: "full",
    onConflict: "update",
    // devices.id is a per-environment random UUIDv7 (Device.generate()), minted independently by each
    // environment's own registry-sync run — so EVERY row drifts (16/16 when this landed), not the
    // occasional row areas/point_info see. Dev must ADOPT prod's uuid: it is the FK-join key all four
    // children carry, and points.device_id in particular is how a synced point finds its device.
    idDrift: {
      uniqueKeys: [
        ["rid"], // devices_rid_unique
        ["owner_user_id", "slug"], // devices_owner_slug_unique
      ],
      // Nothing is cleared: all four FKs into devices.id are NO ACTION and non-deferrable, points.device_id
      // is NOT NULL, and the points themselves can't be deleted regardless (point_readings.point_rid →
      // points.rid, ~13M rows). So every child MOVES onto prod's uuid instead — see `repoint` on areas.
      children: [],
      repoint: [
        { table: "points", cols: ["device_id"] },
        { table: "area_members", cols: ["device_id"] },
        { table: "device_state", cols: ["device_id"] },
        { table: "legacy_handles", cols: ["device_id"] },
      ],
      // `rid` is NOT NULL, so unlike areas' nullable keys there is nothing to NULL. Push the drifted dev
      // row into the negative range instead: disjoint from every staged prod rid (both sequences allocate
      // upward from 1), and distinct across drifted rows because rid is unique. The `- 1` keeps rid 0 —
      // which no live sequence produces, but costs nothing to exclude — off its own identity. The row is
      // deleted at the end of the same transaction, so the sentinel is never observable outside it.
      neutralize: [{ col: "rid", expr: "-d.rid - 1" }, "slug"],
    },
  },
  // points.id is DETERMINISTIC — uuidv5, and identical to point_info.point_uid by the seam invariant — so
  // both environments independently mint the SAME id for the same logical point (0/134 drift when this
  // landed) and a plain by-PK upsert works. Only device_id diverged, and `devices` above has already
  // repointed dev's rows onto prod's uuids by the time this leg runs.
  { name: "points", mode: "full", onConflict: "update" },
  // Natural composite/1:1 PKs, no surrogate — plain by-PK upserts, after both FK parents.
  { name: "area_members", mode: "full", onConflict: "update" },
  { name: "device_state", mode: "full", onConflict: "update" },
  // Frozen-at-cutover handle→device/area map. Previously left out of the manifest deliberately, but it is
  // also an areas idDrift CHILD — so a realigning area cleared its handle rows with no later leg to restore
  // them (dev sat 2 handles short of prod). Syncing it here closes that leak. Either partial unique index
  // can name a different dev row than the PK does if a handle was ever re-pointed, so clear those
  // collisions rather than letting one abort the whole run.
  {
    name: "legacy_handles",
    mode: "full",
    onConflict: "update",
    replaceConflicts: [["device_id"], ["area_id"]],
  },
  // The `point_info` leg (a full upsert with a four-key `idDrift` block) was REMOVED with the table in
  // migration 0051. `points` above is the replacement and needs none of that machinery: its `id` is
  // deterministic (uuidv5), so both environments mint the SAME id for the same logical point and a plain
  // by-PK upsert lands.
  //
  // ⚠️ Residual, PRE-EXISTING and deliberately unchanged here: `points_rid_unique` can still drift, since
  // each environment's `point_rid_seq` allocates independently — and the `points` leg has never carried an
  // `idDrift` for it. Removing `point_info`'s `["rid"]` key does NOT create that gap: that key protected the
  // `point_info` DELETE, not the `points` upsert. Left as-is rather than folded into a drop migration's PR;
  // it surfaces as a loud unique violation on a dispatch, never as silent data loss.
  // Surrogate-key tables: the PK (uuid/serial `id`) is assigned independently on
  // dev, so dev and prod hold the same row under different ids. Upsert on the
  // NATURAL unique key and exclude `id` (like point_readings) — otherwise the
  // insert misses the PK conflict and trips the natural unique constraint,
  // aborting the whole sync before it reaches the readings tables.
  {
    name: "area_bindings",
    mode: "full",
    onConflict: "update",
    // Re-based by migration 0047 onto `area_bindings_unique (area_id, role, metric_type, point_uid)`.
    // ON CONFLICT names an INDEX by its columns, so this list and that index must move together —
    // which is why this ships in the same PR as the migration rather than trailing it.
    conflictCols: ["area_id", "role", "metric_type", "point_uid"],
    // Phase 4 added a second identity for a binding's ordered slot. A point can
    // move priority while dev still has another point in that slot; ON CONFLICT
    // can nominate only one unique index, so clear the other collision first.
    replaceConflicts: [["area_id", "role", "metric_type", "priority"]],
    excludeCols: ["id"],
  },
  // Derived-signal config (run detectors + the HWS model). A plain by-PK upsert: `derivations.id`
  // is DETERMINISTIC — uuidv5 over (area, kind, role), see lib/derivations/ids.ts — and areas share
  // their uuid across environments, so prod and dev independently mint the SAME id for the same
  // logical derivation. Hence no excludeCols/natural-key dance (and a role-less row, i.e. the HWS
  // model, still has a stable identity). Must follow `areas` — the area_id FK parent.
  //
  // The intervals themselves are NOT copied: derived_intervals has a composite PK (can't use
  // mirror) and its rows shift/merge under recompute, so a copy would orphan stale rows — dev
  // recomputes them from the synced readings instead (db:recompute-dev-runs).
  {
    name: "derivations",
    mode: "full",
    onConflict: "update",
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
  // Change-only log of Amber price forecasts (see the schema doc-comment). Append-only with
  // created_at defaultNow, so created_at is a valid watermark (same choice as `sessions`).
  // FK parent `devices` is a FULL table copied earlier in the run.
  {
    name: "amber_forecast_history",
    mode: "incremental",
    watermark: "created_at",
    overlap: "1 hour",
    onConflict: "nothing",
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
// pg-connection-string can't handle PlanetScale's `sslrootcert=device` (it tries
// to open('device') as a file → ENOENT and the connection dies). Managed Postgres
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

  // 2b. Stage prod's slice of each cross-key satellite table (see CrossKey). Must happen BEFORE the
  // `_drift` computation reads it, and it is a separate helper table because the satellite's own
  // manifest leg runs later and would otherwise clash on `sync_staging.<table>`.
  for (const ck of idDrift?.crossKeys ?? []) {
    const ckCols = [ck.parentCol, ...ck.keyCols].join(", ");
    await dev.query(
      `DROP TABLE IF EXISTS ${crossKeyStaging(ck)};
       CREATE UNLOGGED TABLE ${crossKeyStaging(ck)} AS
         SELECT ${ckCols} FROM public.${ck.table} WITH NO DATA;`,
    );
    await pipeline(
      prod.query(
        copyTo(
          `COPY (SELECT ${ckCols} FROM public.${ck.table}
                  WHERE ${ck.parentCol} IS NOT NULL) TO STDOUT`,
        ),
      ),
      dev.query(copyFrom(`COPY ${crossKeyStaging(ck)} (${ckCols}) FROM STDIN`)),
    );
    // The join in `crossMatch` is the hot path of the `_drift` scan and this table has no stats at all
    // until analyzed — same reasoning as the `ANALYZE _drift` below.
    await dev.query(`ANALYZE ${crossKeyStaging(ck)};`);
  }

  // 3. Upsert into dev. The transaction paths ROLLBACK before rethrowing so a failure
  // never leaves the persistent dev connection stuck in an aborted transaction.
  try {
    if (idDrift) {
      // Same-logical-row-different-PK: dev rows sharing ANY secondary unique key with a staged prod row
      // but sitting under a different PK. Whichever key collides would abort the by-PK upsert, so clear
      // them (and their FK children — not all ON DELETE CASCADE) inside the upsert's transaction. `_drift`
      // carries the parent's PK columns; children map their FK columns positionally onto that PK.
      const crossKeys = idDrift.crossKeys ?? [];
      if (crossKeys.length > 0 && pk.length !== 1) {
        // Fail LOUD rather than emit a match that silently never fires — a drift key that has stopped
        // matching is invisible (see CrossKey), so this must never degrade quietly.
        throw new Error(
          `${t.name}: idDrift.crossKeys needs a single-column PK, got [${pk.join(", ")}]`,
        );
      }
      // Cross-table identities (see CrossKey): correlate through dev's satellite table and prod's staged
      // copy of it. OR-ed in alongside the on-table `uniqueKeys` — a row is the same logical row if ANY
      // key says so, exactly as before.
      const crossMatch = crossKeys.map((ck) => {
        const on = ck.keyCols.map((c) => `xs.${c} = xd.${c}`).join(" AND ");
        return `(EXISTS (SELECT 1
                   FROM public.${ck.table} xd
                   JOIN ${crossKeyStaging(ck)} xs ON (${on})
                  WHERE xd.${ck.parentCol} = d.${pk[0]}
                    AND xs.${ck.parentCol} = s.${pk[0]}))`;
      });
      const match = [
        ...idDrift.uniqueKeys.map(
          (key) => "(" + key.map((c) => `d.${c} = s.${c}`).join(" AND ") + ")",
        ),
        ...crossMatch,
      ].join(" OR ");
      const samePk = pk.map((c) => `d.${c} = s.${c}`).join(" AND ");
      const childDeletes = idDrift.children
        .map((c) => {
          const on = c.cols
            .map((col, i) => `x.${col} = b.${pk[i]}`)
            .join(" AND ");
          return `DELETE FROM public.${c.table} x USING _drift b WHERE ${on};`;
        })
        .join("\n       ");
      // A repointed FK must be MOVED to prod's PK, so `_drift` has to carry that PK too — captured as
      // `new_<col>` from the staged prod row. Only selected when repointing, so the no-repoint tables
      // (dashboards, point_info) emit exactly the SQL they always did.
      const repoint = idDrift.repoint ?? [];
      const newPkCols = repoint.length
        ? ", " + pk.map((c) => `s.${c} AS new_${c}`).join(", ")
        : "";
      // Cleared BEFORE the upsert so prod's row can be inserted alongside the drifted one — the repoint
      // UPDATE below needs it present as its FK target. Both rows coexist only inside this transaction.
      const neutralize = idDrift.neutralize?.length
        ? `UPDATE public.${t.name} d SET ${idDrift.neutralize
            .map((c) =>
              typeof c === "string" ? `${c} = NULL` : `${c.col} = ${c.expr}`,
            )
            .join(", ")}
         FROM _drift b WHERE ${pk.map((c) => `d.${c} = b.${c}`).join(" AND ")};`
        : "";
      // AFTER the upsert (needs prod's row to exist) and BEFORE the parent delete (which it unblocks).
      const repoints = repoint
        .map((c) => {
          const set = c.cols
            .map((col, i) => `${col} = b.new_${pk[i]}`)
            .join(", ");
          const on = c.cols
            .map((col, i) => `x.${col} = b.${pk[i]}`)
            .join(" AND ");
          return `UPDATE public.${c.table} x SET ${set} FROM _drift b WHERE ${on};`;
        })
        .join("\n       ");
      const parentDelete = `DELETE FROM public.${t.name} d USING _drift b
         WHERE ${pk.map((c) => `d.${c} = b.${c}`).join(" AND ")};`;
      // Without a repoint the drifted row has no un-clearable dependants, so the original order stands:
      // delete it, THEN upsert prod's row into the vacated unique-key slot.
      //
      // With one, the drifted row cannot be deleted until its NOT NULL/NO ACTION dependants have been
      // moved — and they cannot be moved until prod's row exists to point at. So the order inverts, and
      // `neutralize` is what lets the two rows coexist across the middle of it:
      //   neutralize (free the unique keys) → upsert (prod's row lands) → repoint → delete the drifted row.
      const realign = repoint.length
        ? `${neutralize}
       ${upsert}
       ${repoints}
       ${parentDelete}`
        : `${parentDelete}
       ${upsert}`;
      // ANALYZE _drift before the child DELETEs: it's a just-created temp table with no
      // stats, and on the normal (no-drift) run it's EMPTY. Without stats the planner
      // mis-estimates its cardinality and full-seq-scans the huge child tables
      // (point_readings ~13M, agg_5m ~3M) to find zero matches — ~40s/run for nothing.
      // Accurate stats ⇒ a trivial nested loop keyed off _drift (never scans the big
      // tables when empty; index-probes them when drift is genuinely present).
      await dev.query(
        `BEGIN;
       CREATE TEMP TABLE _drift ON COMMIT DROP AS
         SELECT DISTINCT ${pk.map((c) => `d.${c}`).join(", ")}${newPkCols}
           FROM public.${t.name} d
           JOIN sync_staging.${t.name} s ON (${match})
          WHERE NOT (${samePk});
       ANALYZE _drift;
       ${childDeletes}
       ${realign}
       COMMIT;
       DROP TABLE sync_staging.${t.name};
       ${crossKeys.map((ck) => `DROP TABLE IF EXISTS ${crossKeyStaging(ck)};`).join("\n       ")}`,
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
