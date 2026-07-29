/**
 * PlanetScale PostgreSQL Schema
 *
 * PostgreSQL version of the full database schema.
 * Uses drizzle-orm/pg-core for PostgreSQL types.
 *
 * ## SQLite vs PostgreSQL Schema Comparison
 *
 * | Aspect              | SQLite (legacy)                   | PostgreSQL (PlanetScale)         |
 * |---------------------|-----------------------------------|----------------------------------|
 * | ORM module          | drizzle-orm/sqlite-core           | drizzle-orm/pg-core              |
 * | Auto-increment PK   | integer().primaryKey({autoIncr})  | serial()                         |
 * | Booleans            | integer({mode:"boolean"})         | boolean()                        |
 * | Timestamps          | integer({mode:"timestamp"})       | timestamp (UTC, no timezone)     |
 * | Floating point      | real()                            | doublePrecision()                |
 * | JSON                | text({mode:"json"})               | jsonb()                          |
 * | Default timestamp   | sql`(unixepoch())`                | defaultNow()                     |
 *
 * ## Key Differences
 *
 * 1. **Timestamps**: SQLite stores as unix epoch (seconds/ms), PG uses native timestamp.
 *    - All timestamps use `timestamp()` without timezone (data stored in UTC)
 *    - Time-series tables use native timestamps for optimal query performance
 *    - Migration: Convert epoch ms → `new Date(ms)` on insert
 *
 * 2. **JSON**: SQLite uses TEXT with mode:"json", PG uses native JSONB (faster queries)
 *
 * 3. **Foreign Keys**: PG was built FK-less for receiver throughput; the relational
 *    graph is restored by the decommission-time FK rebuild (migration `0006`). Large
 *    tables (`point_readings`, `agg_5m`, `sessions`) are added `NOT VALID` then VALIDATEd
 *    in a separate step (see the hand-edited migration SQL).
 *
 * 4. **Sequences**: PostgreSQL serial() auto-increments independently per table.
 *    Session IDs will diverge between SQLite and PG databases.
 */

import {
  pgTable,
  serial,
  bigserial,
  integer,
  bigint,
  text,
  uuid,
  doublePrecision,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  timestamp,
  date,
  pgSequence,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";
import type { DeviceConfig } from "@/lib/capabilities/config";
import type { AreaConfig } from "@/lib/areas/types";

// ============================================================================
// Systems table - stores inverter system information
// ============================================================================
export const systems = pgTable(
  "systems",
  {
    id: serial("id").primaryKey(),
    ownerClerkUserId: text("owner_clerk_user_id"),
    vendorType: text("vendor_type").notNull(),
    vendorSiteId: text("vendor_site_id").notNull(),
    status: text("status").notNull().default("active"),
    displayName: text("display_name").notNull(),
    alias: text("alias"),
    model: text("model"),
    serial: text("serial"),
    ratings: text("ratings"),
    solarSize: text("solar_size"),
    batterySize: text("battery_size"),
    location: jsonb("location"),
    metadata: jsonb("metadata"),
    // Typed, user-editable per-device config (capability on/off overrides, nameplate kW, update
    // cadence, …). Distinct from `metadata` (adapter-owned credentials/diagnostics). Grows without
    // migrations. See lib/capabilities/config.ts.
    config: jsonb("config").$type<DeviceConfig>(),
    timezoneOffsetMin: integer("timezone_offset_min").notNull(),
    displayTimezone: text("display_timezone").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // Vendor-reported commissioning / "open" day (local calendar date, "YYYY-MM-DD"): the system's
    // earliest-possible data date. Distinct from `created_at` (LiveOne onboarding). Floors the
    // coverage-repair window so pre-commission days aren't flagged as phantom gaps AND genuine
    // pre-onboarding history stays in range. Null when unknown → the runner falls back to created_at.
    // Populated at onboarding (e.g. Sigenergy `stationOpenTime`) and lazily on first repair.
    commissionedOn: date("commissioned_on"),
  },
  (table) => ({
    ownerClerkUserIdx: index("owner_clerk_user_idx").on(table.ownerClerkUserId),
    statusIdx: index("systems_status_idx").on(table.status),
    // Indexed lookup for getSystemByVendorSiteId (OAuth/webhook dedup) — avoids a fleet scan at scale.
    vendorSiteIdIdx: index("systems_vendor_site_id_idx").on(table.vendorSiteId),
    aliasUnique: uniqueIndex("alias_unique").on(
      table.ownerClerkUserId,
      table.alias,
    ),
  }),
);

// ============================================================================
// Polling Status table — track health and errors.
//
// ⚠️ FROZEN as of config-v4 Phase 12 slice C (2026-07-28). `device_state` is the live table; nothing
// reads or writes this one. It is kept, unchanged, as the pre-flip rollback snapshot until slice N
// drops it (with `point_info` and `systems`, in FK order). Do not add a reader or a writer.
// ============================================================================
export const pollingStatus = pgTable(
  "polling_status",
  {
    id: serial("id").primaryKey(),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    lastPollTime: timestamp("last_poll_time"),
    lastSuccessTime: timestamp("last_success_time"),
    lastErrorTime: timestamp("last_error_time"),
    lastError: text("last_error"),
    lastResponse: jsonb("last_response"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    totalPolls: integer("total_polls").notNull().default(0),
    successfulPolls: integer("successful_polls").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    systemIdx: index("polling_system_idx").on(table.systemId),
    systemIdUnique: uniqueIndex("polling_status_system_id_unique").on(
      table.systemId,
    ),
  }),
);

// The `user_systems` junction table — the pre-Areas per-system access grant — was dropped by
// migration 0045 (config-v4 Phase 12 slice F), releasing an FK into `systems`. It held ZERO rows on
// prod, and the clean-sheet retires it with no replacement: sharing is `dashboard_grants` +
// `share_tokens`. Read access is now exactly owner ∪ ownerless-is-public ∪ admin, plus whatever a
// dashboard grant implies (`grantedSystemScopeForUser`, lib/dashboard/grants.ts). The grant never
// conveyed write access, so nothing about `canWrite` changed.

// ============================================================================
// Users table - stores user preferences
// ============================================================================
export const users = pgTable(
  "users",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    // The default landing DASHBOARD (P6: the legacy per-system `default_system_id` was dropped). FK to
    // dashboards.id, ON DELETE SET NULL so deleting the dashboard silently clears the default. (forward
    // ref: `dashboards` is declared later in this module.)
    // ⚠️ config-v4 CUTOVER SHAPE — transform stage 5d re-keys this int → the dashboards uuid.
    defaultDashboardId: uuid("default_dashboard_id").references(
      () => dashboards.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    defaultDashboardIdx: index("users_default_dashboard_idx").on(
      table.defaultDashboardId,
    ),
  }),
);

// ============================================================================
// Sessions table - tracks communication sessions with energy systems
// ============================================================================
export const sessions = pgTable(
  "sessions",
  {
    // App-minted UUIDv7 (text). Historical ids are stringified integers (E1).
    // Was `serial`; the receiver always supplies an explicit id.
    id: text("id").primaryKey(),
    sessionLabel: text("session_label"),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id),
    cause: text("cause").notNull(),
    duration: integer("duration").notNull(), // milliseconds
    successful: boolean("successful"),
    errorCode: text("error_code"),
    error: text("error"),
    response: jsonb("response"),
    numRows: integer("num_rows").notNull(),
    // Migration: import from the legacy store's sessions.started
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => ({
    // The old (system_id, created_at) unique was a dedup crutch for the
    // separate-session-publish path; with UUIDv7 text PKs the id alone
    // guarantees distinctness, and the unique would reject legitimate
    // same-instant sessions — dropped in PR-7b.
    systemIdx: index("sessions_system_idx").on(table.systemId),
    createdAtIdx: index("sessions_created_at_idx").on(table.createdAt),
    causeIdx: index("sessions_cause_idx").on(table.cause),
  }),
);

// ============================================================================
// Point Info table - stores individual monitoring points
// ============================================================================

// Global point rid allocator (config-v4 Phase 2, migration 0030). Declared so the schema model fully
// describes final DB state and drizzle's machine-written snapshot stays authoritative; the actual
// CREATE SEQUENCE + deterministic backfill + OWNED BY are hand-authored in 0030 (drizzle can't express
// them). Below the uuid↔rid seam, hot tables re-key to `rid` at cutover; nothing above the seam reads it.
export const pointRidSeq = pgSequence("point_rid_seq");

export const pointInfo = pgTable(
  "point_info",
  {
    // Composite primary key (systemId, index)
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id),
    index: integer("id").notNull(), // Sequential per system

    // Global integer identity, sequence-allocated (see pointRidSeq). Additive — the per-system
    // (system_id, id) ADDRESS and all composite FKs are untouched.
    //
    // Since config-v4 slice M `point_info` is the WRITE-BEHIND copy: `points` is written first and
    // allocates the rid from its own DEFAULT on the SAME sequence, and `mintPoint` then names BOTH
    // `rid` and `index` here with that value (index == rid). So the old "writers must NEVER name rid"
    // rule is superseded — what remains absolute is that the value comes from `point_rid_seq` (via the
    // `points` row), NEVER from a scan: introduce no max(rid)+1 / max(index)+1 pattern.
    rid: integer("rid")
      .notNull()
      .default(sql`nextval('point_rid_seq')`),

    // Paths
    physicalPathTail: text("physical_path_tail").notNull(),
    logicalPathStem: text("logical_path_stem"),

    // Metric info
    metricType: text("metric_type").notNull(),
    metricUnit: text("metric_unit").notNull(),

    // Display
    defaultName: text("point_name").notNull(),
    displayName: text("display_name").notNull(),
    subsystem: text("subsystem"),

    // Flags
    transform: text("transform"),
    active: boolean("active").notNull().default(true),

    // Stable, vendor-derived IDENTITY (HA `unique_id` analog), distinct from the renameable
    // (system_id, index) ADDRESS. Deterministic uuidv5 over (vendor_type, vendor_site_id,
    // physical_path_tail) — see lib/identifiers/point-uid.ts — so re-onboarding the same physical
    // point reproduces the same uid; a duplicate-site collision falls back to a random uid. Nullable
    // for now (backfilled + minted by ensurePointInfo going forward); a later migration may tighten
    // to NOT NULL. See docs/plans/identity-address-split-and-labels.md (Part 1).
    // Tightened to NOT NULL in config-v4 Phase 2 (migration 0030) after the backfill + writer-fix.
    pointUid: uuid("point_uid").notNull(),

    // Timestamps
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.systemId, table.index] }),
    systemPhysicalPathUnique: uniqueIndex("pi_system_physical_path_unique").on(
      table.systemId,
      table.physicalPathTail,
    ),
    // NULLs are distinct in Postgres, so this permits many un-backfilled (null) rows while still
    // enforcing one row per non-null identity.
    pointUidUnique: uniqueIndex("pi_point_uid_unique").on(table.pointUid),
    ridUnique: uniqueIndex("pi_rid_unique").on(table.rid),
    systemStemMetricUnique: uniqueIndex("pi_system_stem_metric_unique").on(
      table.systemId,
      table.logicalPathStem,
      table.metricType,
    ),
    systemIdx: index("pi_system_idx").on(table.systemId),
    subsystemIdx: index("pi_subsystem_idx").on(table.subsystem),
  }),
);

// ============================================================================
// Point Readings table - stores raw time-series data
// ============================================================================
export const pointReadings = pgTable(
  "point_readings",
  {
    // ⚠️ config-v4 CUTOVER SHAPE — the (point_rid, time) twin from config-transform stage 4. The composite
    // (system_id, point_id) address AND the serial `id` are gone; rows key on the internal `point_rid` (a
    // FK → points.rid). Only the readings seam (lib/readings/**) imports this.
    //
    // The index/PK names below are canonical as of migration 0039. They carried the transform's `_new`
    // suffix from the cutover until then: index and PK-constraint names are schema-GLOBALLY unique in
    // Postgres, and the retained `point_readings_old` still owned `point_readings_pkey` /
    // `pr_measurement_time_idx` / `pr_created_at_idx`, so renaming before 0038 dropped `_old` would
    // have been a 42P07.
    pointRid: integer("point_rid")
      .notNull()
      .references(() => points.rid),
    // Session id is text (UUIDv7 / stringified-int historical); FK to sessions(id). NULL is allowed.
    sessionId: text("session_id").references(() => sessions.id),

    // Timestamps (UTC)
    measurementTime: timestamp("measurement_time").notNull(),
    receivedTime: timestamp("received_time").notNull(),

    // Core measurements
    value: doublePrecision("value"),
    valueStr: text("value_str"),

    // Quality & status
    error: text("error"),
    dataQuality: text("data_quality").notNull().default("good"),

    // When this row was ingested into Postgres (defaultNow); distinct from measurement/received time.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "point_readings_pkey",
      columns: [table.pointRid, table.measurementTime],
    }),
    measurementTimeIdx: index("pr_measurement_time_idx").on(
      table.measurementTime,
    ),
    createdAtIdx: index("pr_created_at_idx").on(table.createdAt),
  }),
);

// ============================================================================
// 5-minute aggregation table
// ============================================================================
export const pointReadingsAgg5m = pgTable(
  "point_readings_agg_5m",
  {
    // ⚠️ config-v4 CUTOVER SHAPE — the (point_rid, interval_end) twin (config-transform stage 4).
    pointRid: integer("point_rid")
      .notNull()
      .references(() => points.rid),
    intervalEnd: timestamp("interval_end").notNull(),

    // Optional session tracking (text: UUIDv7 / stringified-int historical). No FK on the 5m twin.
    sessionId: text("session_id"),

    // Aggregates
    avg: doublePrecision("avg"),
    min: doublePrecision("min"),
    max: doublePrecision("max"),
    last: doublePrecision("last"),
    delta: doublePrecision("delta"),
    valueStr: text("value_str"),

    // Sampling metadata
    sampleCount: integer("sample_count").notNull(),
    errorCount: integer("error_count").notNull(),
    dataQuality: text("data_quality"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "pr5m_pkey",
      columns: [table.pointRid, table.intervalEnd],
    }),
    intervalEndIdx: index("pr5m_interval_end_idx").on(table.intervalEnd),
    createdAtIdx: index("pr5m_created_at_idx").on(table.createdAt),
    // Watermark column for the incremental prod→dev sync (sync-prod-to-dev-db.ts).
    updatedAtIdx: index("pr5m_updated_at_idx").on(table.updatedAt),
  }),
);

// ============================================================================
// Daily aggregation table
// ============================================================================
export const pointReadingsAgg1d = pgTable(
  "point_readings_agg_1d",
  {
    // ⚠️ config-v4 CUTOVER SHAPE — the (point_rid, day) twin (config-transform stage 4).
    pointRid: integer("point_rid")
      .notNull()
      .references(() => points.rid),
    day: text("day").notNull(), // YYYY-MM-DD format

    // Aggregates
    avg: doublePrecision("avg"),
    min: doublePrecision("min"),
    max: doublePrecision("max"),
    last: doublePrecision("last"),
    delta: doublePrecision("delta"),

    // Sampling metadata
    sampleCount: integer("sample_count").notNull(),
    errorCount: integer("error_count").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "pr1d_pkey",
      columns: [table.pointRid, table.day],
    }),
    dayIdx: index("pr1d_day_idx").on(table.day),
  }),
);

// ============================================================================
// point_readings_flow_attr_1d — the per local-day, per (source, load) directional flow matrix: energy
// PLUS the attributed metric legs (emissions/renewable/cost). The SOLE flow/Sankey matrix — the legacy
// energy-only `point_readings_flow_1d` was retired, so this table's `energy_kwh` is what the Sankey reads.
//
// Built by the engine from `point_readings_agg_5m` (NOT `agg_1d`, whose daily avg cancels bidirectional
// direction) via the unified `computeFlowAccounting`. Energy is ALWAYS >= 0; direction is encoded by
// which slot a flow lands in: battery charge → load.battery, discharge → source.battery; grid import →
// source.grid, export → load.grid. Path-keyed (not point-keyed) so aggregated solar (one node for many
// points) and the synthetic `load.rest-of-house` have stable identities; labels/colors resolve at read
// time. A multi-day range is a plain `SUM(energy_kwh) GROUP BY (source_path, load_path)`.
//
// `area_id` is the LOGICAL SYSTEM / view the flows belong to (`resolveLogicalSystem`): an area-of-one
// over a single physical system, OR a multi-device area whose points are drawn from CHILD systems (the
// cross-system origin is collapsed into the Area; cross-system *edges* aren't representable). A
// multi-device area and its members' areas-of-one each get their own rows, so a portfolio rollup must
// never sum a multi-device area AND its members.
//
// The metric columns (emissions_g / renewable_kwh / cost_c) = energy × each source's per-interval
// intensity (grid from OpenElectricity/Amber, battery from the provenance blend, solar = clean/free);
// they are NULLABLE (intensity unknown for that edge/day → null; never perturbs energy). `estimated_kwh`
// is the confidence denominator ("% estimated"); `finalized_at` marks a day past the ~72h
// estimated→final cutoff.
// ============================================================================
export const pointReadingsFlowAttr1d = pgTable(
  "point_readings_flow_attr_1d",
  {
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id),
    day: text("day").notNull(), // YYYY-MM-DD, system-local (same convention as agg_1d)
    sourcePath: text("source_path").notNull(),
    loadPath: text("load_path").notNull(),

    // Energy leg — the flow allocation's per-edge energy; what the Sankey reads (always >= 0).
    energyKwh: doublePrecision("energy_kwh").notNull(), // always >= 0

    // Metric legs — null when the source's intensity was unknown for that edge/day.
    emissionsG: doublePrecision("emissions_g"), // attributed gCO2
    renewableKwh: doublePrecision("renewable_kwh"), // attributed renewable energy (kWh)
    // Joint behind-the-meter-AND-renewable energy (kWh) — the renewables tile's autarky /
    // own-renewable-self-consumption legs. Null = self-renewable intensity unknown for that edge/day
    // (a partial-day edge makes metrics 1-2 unavailable; metric 3 uses renewable_kwh and is unaffected).
    selfRenewableKwh: doublePrecision("self_renewable_kwh"),
    costC: doublePrecision("cost_c"), // attributed cost (cents, signed)

    // Confidence: energy whose attribution used an estimated/unknown source intensity.
    estimatedKwh: doublePrecision("estimated_kwh").notNull().default(0),

    sampleCount: integer("sample_count").notNull(), // # of 5m intervals that contributed
    version: integer("version").notNull().default(1), // algorithm version → backfill can detect stale rows
    finalizedAt: timestamp("finalized_at"), // set once the day is past the estimated→final cutoff

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.areaId, table.day, table.sourcePath, table.loadPath],
    }),
    dayIdx: index("prfa1d_day_idx").on(table.day),
    areaDayIdx: index("prfa1d_area_day_idx").on(table.areaId, table.day),
  }),
);

// ============================================================================
// Battery-provenance daily state — ONE row per (battery Area, local day): the single canonical home
// for all per-day battery-provenance state (see docs/architecture/battery-provenance.md).
//   • learn INPUTS — per-day reductions of the raw agg_5m registers (charge/discharge/SoC), computed
//     once at reduce time so the daily learn reads ~330 tiny rows instead of ~380k agg_5m rows;
//   • learned PARAMS — the per-day APPLIED η / C / η_c / idle the fold reads back (replaces the four
//     helper param points; natural units — η/η_c are RATIOS, not the points' ×100 percent);
//   • fold_state — the fold checkpoint at the START of the day (Phase B; enables the O(today) minutely
//     reconcile). Its model version lives INSIDE the envelope (fold_state.v); the row-level `version`
//     is the reduce-algorithm version (a mismatch triggers a full input rebuild).
// Carry columns make each row a resumable seam: re-reducing day D+1 from row D's carry reproduces the
// full-history scan byte-for-byte (capacity boundary down-swing pair + recal-detector resume state).
// ============================================================================
export const batteryProvenanceDaily = pgTable(
  "battery_provenance_daily",
  {
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id),
    day: text("day").notNull(), // YYYY-MM-DD, area-local (same convention as agg_1d)

    // Timeline anchor + shape. NULL first_interval_end = row not yet filled by the learn (e.g. a
    // checkpoint-only insert); the param read-back anchors each day's step at this timestamp.
    firstIntervalEnd: timestamp("first_interval_end"),
    intervalCount: integer("interval_count").notNull().default(0),

    // Learn INPUTS (per-day reductions from agg_5m)
    chargeKwh: doublePrecision("charge_kwh").notNull().default(0), // ungated Σ (η + losses input)
    dischargeKwh: doublePrecision("discharge_kwh").notNull().default(0), // ungated Σ
    socFirst: doublePrecision("soc_first"), // first non-null FF SoC in day
    socLast: doublePrecision("soc_last"), // last non-null FF SoC in day
    socMin: doublePrecision("soc_min"), // min non-null FF SoC in day (reserve-floor learn input)
    socSamples: integer("soc_samples").notNull().default(0), // non-null 5m intervals
    // Capacity-fit pair sums, RAIL-GATED (both pair SoCs non-null & <98) — distinct from the ungated
    // sums above; window seed = 100·Σcap_discharge/Σdown_swing is additive over rows.
    capDischargeKwh: doublePrecision("cap_discharge_kwh").notNull().default(0),
    downSwingPct: doublePrecision("down_swing_pct").notNull().default(0), // incl. boundary pair via carry
    // Largest continuous net-charging run in the day (kWh) — SoC-INDEPENDENT capacity-floor input
    // (capacity.ts#chargeRunKwhByDay): catches a capacity upgrade through a SoC-blind stretch.
    chargeRunKwh: doublePrecision("charge_run_kwh").notNull().default(0),
    recal: boolean("recal").notNull().default(false), // BMS-recalibration day (excluded from all fits)

    // Carry / seam state (resume-at-day-D+1 inputs)
    socLastSlotPct: doublePrecision("soc_last_slot_pct"), // FF SoC at day's LAST slot (boundary-pair s0)
    socCarryPct: doublePrecision("soc_carry_pct"), // last non-null SoC obs ≤ day end (recal prevSoc; may be inherited)
    netAfterSocKwh: doublePrecision("net_after_soc_kwh").notNull().default(0), // Σ(charge−discharge) after that obs

    // Invalidation-probe baseline: what agg_1d's energy-register deltas said at reduce time
    // (null = area has no bound energy registers → probe not applicable).
    probeChargeKwh: doublePrecision("probe_charge_kwh"),
    probeDischargeKwh: doublePrecision("probe_discharge_kwh"),

    // Learned PARAMS (per-day APPLIED values; null during fit warm-up / SoC-blind history)
    eta: doublePrecision("eta"), // round-trip η, ratio
    capacityKwh: doublePrecision("capacity_kwh"), // usable capacity C
    chargeEff: doublePrecision("charge_eff"), // η_c, ratio
    idleLossKwhDay: doublePrecision("idle_loss_kwh_day"),
    reserveFloorPct: doublePrecision("reserve_floor_pct"), // APPLIED reserve floor %: learned SoC-minima quantile clamped to [5, config.reserveFloorMaxPct ?? 10] (the assumed physical floor); see reserve-floor.ts

    // Fold checkpoint at the START of this local day (FoldCheckpointEnvelope; Phase B writes it).
    foldState: jsonb("fold_state"),

    version: integer("version").notNull().default(1), // reduce-algorithm version (BATTERY_DAILY_VERSION)
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.areaId, table.day] }),
    dayIdx: index("bpd_day_idx").on(table.day),
  }),
);

export type BatteryProvenanceDailyRow =
  typeof batteryProvenanceDaily.$inferSelect;
export type NewBatteryProvenanceDailyRow =
  typeof batteryProvenanceDaily.$inferInsert;

// ============================================================================
// Share tokens - view-only access links scoped to systems owned by the token's owner
// (mirrors the legacy `share_tokens`). Epoch-ms columns use bigint(mode:"number") so
// share-tokens.ts's `Date.now()` comparisons work unchanged against Postgres.
// ============================================================================
export const shareTokens = pgTable("share_tokens", {
  // ⚠️ config-v4 CUTOVER SHAPE — the UNIFIED per-dashboard share token. Transform stage 5d folded
  // dashboard_share_tokens in 1:1 (epoch-ms → naive-UTC `timestamp`), re-pointed the last legacy
  // owner-scoped row at an auto-created dashboard, then flipped dashboard_id NOT NULL. The legacy
  // owner_clerk_user_id + the *_ms columns were retained through the cutover and are DROPPED by
  // migration 0037 — the `timestamp` columns below are the sole source of truth.
  token: text("token").primaryKey(), // 3-word phrase, e.g. "leaping-fizzy-wombat"
  dashboardId: uuid("dashboard_id")
    .notNull()
    .references(() => dashboards.id, { onDelete: "cascade" }),
  label: text("label"),
  createdAt: timestamp("created_at"),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  lastUsedAt: timestamp("last_used_at"),
});

// ============================================================================
// Observations outbox - the transactional "PG bin before the queue" (Phase 4).
//
// A poll's built QueueMessage(s) are recorded here durably; a relay
// (app/api/cron/relay-outbox) drains unpublished rows to QStash and marks them
// published once accepted. This makes raw durability live on Postgres —
// see docs/architecture/engine-web-separation.md §6.4. Written as a tee in
// parallel with the live direct enqueue.
// ============================================================================
export const observationsOutbox = pgTable(
  "observations_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    systemId: integer("system_id").notNull(),
    // NULL for the no-collector publishObservationBatch path (no session).
    sessionId: text("session_id"),
    // Chunk index within a poll's multi-message set (0 for single-message paths).
    seq: integer("seq").notNull().default(0),
    // The full QueueMessage (env, systemId, batchTime, observations?, session?),
    // republished verbatim by the relay.
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // NULL until the relay enqueues it to QStash and QStash accepts it.
    publishedAt: timestamp("published_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => ({
    // The relay only ever scans unpublished rows, oldest first. A partial index
    // keeps that scan tiny even as published history accumulates before GC.
    unpublishedIdx: index("outbox_unpublished_idx")
      .on(table.createdAt)
      .where(sql`published_at IS NULL`),
    // Dedup poll-path rows on publish retry. publishObservationBatch rows have no
    // session, so the unique only covers session-bearing rows.
    sessionSeqUnique: uniqueIndex("outbox_session_seq_unique")
      .on(table.systemId, table.sessionId, table.seq)
      .where(sql`session_id IS NOT NULL`),
  }),
);

// ============================================================================
// Dashboards - moving from per-(user,system) to first-class COMPOSITION-FIRST (Phase 2b-2).
//
// TARGET model: a dashboard is a NAMED, owner-scoped composition — `descriptor` is an ordered list of
// cards, each bound to its OWN Area (`areaId`), with no home system/area. Addressed by id
// (`/dashboard/{user}/id/{id}`) or `alias` (`/dashboard/{user}/{alias}`, an owner-unique shortname).
//
// TRANSITION (additive, migration 0017): `display_name` + `alias` are added and `system_id` is made
// NULLABLE so new composition dashboards (null system_id) coexist with the legacy per-system rows
// while the old path is still live. `area_id` + the `(user, system_id)` unique index are retained
// (NULLs are distinct, so many composition dashboards are allowed). Phase 2b-2's final step retires
// the legacy path and drops `system_id`/`area_id` + the old unique (migration 0018). `display_name`
// is nullable until then (legacy rows have none). See docs/architecture/areas-and-dashboards.md.
// ============================================================================
export const dashboards = pgTable(
  "dashboards",
  {
    // ⚠️ config-v4 CUTOVER SHAPE (see the `areas` header above for why this branch cannot reach `main`
    // before the window). Stage 5d swaps the serial int PK for a uuid, freezing the old int in
    // `legacy_id`, and renames clerk_user_id→owner_user_id, display_name→name, alias→slug.
    id: uuid("id").primaryKey().defaultRandom(), // 5d sets DEFAULT gen_random_uuid() (defect D-a)
    // The frozen pre-cutover int id. Permanent: it backs the `/dashboard/id/{n}` 301 and the
    // `?systemId=N` compat alias, so it is NOT dropped in Phase 9.
    legacyId: integer("legacy_id"),
    ownerUserId: text("owner_user_id").notNull(), // the owner
    // A dashboard's name + owner-unique shortname (the /dashboard/{user}/{slug} path). Nullable for
    // an unnamed dashboard. The legacy per-system `system_id`/`area_id` handles were dropped in P6 —
    // a dashboard is a composition whose sections each carry their own Area uuid.
    name: text("name"),
    slug: text("slug"), // owner-unique shortname for /dashboard/{user}/{slug}; null = unnamed
    descriptor: jsonb("descriptor").notNull(),
    // The v4 node-tree document (clean-sheet §8). ⚠️ config-v4 CUTOVER SHAPE — NOT NULL (transform stage 5d
    // `ALTER COLUMN doc SET NOT NULL`); `createDashboard` builds it from the descriptor via rewriteV3ToV4.
    doc: jsonb("doc").notNull(),
    // Whole-doc revision counter; bumped by the Phase-6 /api/v4 PUT. DEFAULT 1 so the untouched v3
    // insert path keeps working.
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // (owner_user_id, slug) unique — owner-scoped shortname (NULL slugs distinct). Index NAMES are
    // unchanged: a column rename carries its indexes along, and the transform never renames them.
    ownerAliasUnique: uniqueIndex("dashboards_owner_alias_unique").on(
      table.ownerUserId,
      table.slug,
    ),
    userIdx: index("dashboards_user_idx").on(table.ownerUserId),
    // 5d: ADD CONSTRAINT dashboards_legacy_id_unique UNIQUE (legacy_id).
    legacyIdUnique: uniqueIndex("dashboards_legacy_id_unique").on(
      table.legacyId,
    ),
  }),
);

// NOTE: `dashboard_share_tokens` (the P4 per-dashboard link table) was SUPERSEDED by the unified
// `share_tokens` — config-transform stage 5d folded its rows in 1:1 — and is dropped by migration 0037.
// It had zero query sites and no type exports by then. The functions still NAMED
// `*DashboardShareToken*` in lib/dashboard/sharing.ts operate on `share_tokens`, not on this table.

// ============================================================================
// Dashboard grants (P4) - per-dashboard membership (invite a person to a dashboard).
// Access resolves Dashboard → its cards' bindings → points, so a grant is read-scoped to exactly
// what the dashboard shows. role ∈ owner|admin|viewer. (Grant-management UI is a later phase.)
// ============================================================================
export const dashboardGrants = pgTable(
  "dashboard_grants",
  {
    // ⚠️ config-v4 CUTOVER SHAPE — transform stage 5d: dashboard_id int→uuid, clerk_user_id→user_id,
    // created_at_ms→created_at (naive UTC), role narrowed to admin|viewer (owner→admin), the surrogate
    // `id` dropped, and the (dashboard_id, user_id) unique index promoted to the composite PK
    // `dashboard_grants_pk`. created_at_ms was retained through the cutover and is dropped by 0037.
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // 'admin' | 'viewer'
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "dashboard_grants_pk",
      columns: [table.dashboardId, table.userId],
    }),
    userIdx: index("dashboard_grants_user_idx").on(table.userId),
    roleCheck: check(
      "dashboard_grants_role_check",
      sql`${table.role} IN ('admin','viewer')`,
    ),
  }),
);

export type DashboardGrant = typeof dashboardGrants.$inferSelect;
export type NewDashboardGrant = typeof dashboardGrants.$inferInsert;

// The `roles` table — a SQL projection of lib/roles/registry.ts — was dropped by migration 0044
// (config-v4 Phase 12 slice G). It had no writer and no query site: the registry is CODE, and the
// only thing the table still did was back the area_bindings.role FK. Enforcement moved to the
// `area_bindings_role_check` / `derivations_role_check` CHECK constraints below, which 0032 added
// for exactly this handover. Role METADATA (category/stem/label/ha_*/summary_*) is read from
// lib/roles/registry.ts — there is no longer a SQL-joinable copy, by design.

// ============================================================================
// Areas - the SEMANTIC layer (P3). A named role-set that binds physical points
// into a coherent energy site. Replaced vendor_type='composite' fake systems rows.
//
// An Area is a grouping of 1..N member devices (`area_members`):
//   area-of-one   → 1:1 wrapper over a single physical system (its sole `area_members` member).
//   multi-device  → points drawn from across ≥2 member systems (via `area_bindings`).
// The single-vs-multi distinction is STRUCTURAL (membership), not a stored `kind` — the
// `kind` column was dropped in migration 0019, and the `source_system_id` seam in P6.
//
// `id` is a GUID (decoupled from systems.id). `legacy_system_id` is the integer ADDRESSING
// HANDLE: an area-of-one's == its member's systems.id; a multi-device area's == the old
// composite shim's systems.id. It drives the point_readings_flow_attr_1d.area_id keying.
// Areas are organizational, NOT the access boundary (access stays system-granular until P4).
// ============================================================================
export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(), // app supplies uuidv7(); default is a safety net
    // ⚠️ config-v4 CUTOVER NAMES. `config-transform.ts` stage 2e renames owner_clerk_user_id→owner_user_id,
    // display_name→name, alias→slug IN-WINDOW, so this build only works against a TRANSFORMED database.
    // This is the all-or-nothing cutover build (deployed at step 7) — it must not reach `main` before the
    // window. Why a stale name here is dangerous rather than merely wrong: a projection-less `.select()`
    // on this table (`fetchAreaByHandle`, lib/systems-manager.ts:116) makes drizzle expand EVERY column
    // below, so a mismatch is not a type error — it is a runtime 42703 that `lib/dashboard/access.ts`'s
    // per-area `catch {}` swallows, silently resolving the area to ZERO points. That is exactly the Run-5
    // AC1 "lockout": 35 area_bindings present and correct, 0 points served.
    ownerUserId: text("owner_user_id"),
    // The 1:1 migration seam + the stable integer ADDRESSING HANDLE. For a multi-device area it is
    // the old composite shim's systems.id; no FK to systems, since that area outlives its `systems`
    // row (deleted in migration 0014), and `getSystem(legacy_system_id)` then resolves to the
    // synthesized virtual system. The unique index below stays as the addressing invariant (one Area
    // per handle). RETAINED through the cutover (mapping key + backlog drain); dropped in Phase 9.
    legacySystemId: integer("legacy_system_id"),
    name: text("name").notNull(),
    slug: text("slug"),
    timezoneOffsetMin: integer("timezone_offset_min").notNull(),
    displayTimezone: text("display_timezone").notNull(),
    // --- config-v4 dark columns (Phase 4, migration 0032; nullable/unread by the v3 app) ---
    // Canonical fixed-offset day-bucketing key (clean-sheet §7). Backfilled = timezone_offset_min;
    // immutable after cutover except via an explicit re-bucket op. ⚠️ config-v4 CUTOVER SHAPE — NOT NULL
    // (transform + backfill); `createArea` and the mint mirror (v4-mirror.ts) both supply it = tzOffset.
    dayOffsetMin: integer("day_offset_min").notNull(),
    // Site-level configuration (export tariff, generator source, provenance).
    config: jsonb("config").$type<AreaConfig>(),
    // Per-Area physical location (the semantic layer's equivalent of HA's home-location
    // object; `timezoneOffsetMin`/`displayTimezone` above are its time_zone slice). Typed as
    // `AreaLocation` (lib/areas/types.ts). Used to DERIVE the NEM grid region — never stores the
    // region directly. See docs/architecture/areas-and-dashboards.md.
    location: jsonb("location").$type<AreaLocation>(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // The INDEX NAME stays `areas_owner_alias_unique`: a column rename carries its indexes along
    // untouched, and the transform never renames the index. Only the TS field refs move.
    aliasUnique: uniqueIndex("areas_owner_alias_unique").on(
      table.ownerUserId,
      table.slug,
    ),
    legacySystemUnique: uniqueIndex("areas_legacy_system_unique").on(
      table.legacySystemId,
    ),
  }),
);

// ============================================================================
// Area bindings - the typed role→point edges (P3). One representation that subsumes
// all legacy composite metadata JSON shapes (v2 `mappings`; the dead base_system/
// overrides). One role may bind several points and several metric_types (e.g. battery
// binds a `power` point AND a `soc` point — possibly from different child systems).
//
// `metric_type` comes from the child point_info, NOT from the role — a single v2
// mapping bucket holds mixed metrics (e.g. Kinkora's `grid` bucket is a power point
// plus Amber rate/value/energy points). `ordinal` reproduces the running enumeration
// of buildSubscriptionRegistry so KV composite point refs stay stable. `transform` is
// a per-binding override (nullable → inherit point_info.transform).
//
// ⚠️ CONFIG-V4 Phase 12 slice E SHAPE (migrations 0047 + 0048). `point_uid` — the uuid
// address of the bound point — is the binding's SOLE identity: NOT NULL, the key of both
// `area_bindings_unique` and `area_bindings_point_idx`, and the only thing any reader,
// wire, or KV key addresses the point by. The legacy `(point_system_id, point_id)` pair is
// GONE: 0047 dropped its FK into `point_info` (taking FKs into that table from 1 to 0,
// which is what unblocks slice N's `point_info` drop) and relaxed both columns to NULLable;
// PR 2b converted the last two consumers (the area-builder wire → `pt_` TypeIDs, and the KV
// subscription map's source key → the uuid) and 0048 dropped the columns.
// ============================================================================
export const areaBindings = pgTable(
  "area_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    // Constrained by `area_bindings_role_check` below — the FK to `roles` went with that table in
    // migration 0044 (slice G).
    role: text("role").notNull(),
    metricType: text("metric_type").notNull(), // from point_info: 'power' | 'soc' | 'energy' | 'rate' ...
    // The binding's ADDRESS: the uuid of the bound point. Added ADDITIVELY by config-transform stage 5,
    // declared here by migration 0036, given an application writer by slice E PR 1, made NOT NULL by
    // 0047 (slice E PR 2a) once both environments read 72/72 populated with zero disagreement against
    // the pair it replaced, and left as the only address by 0048 (slice E PR 2b). Plain NO ACTION:
    // deleting a `points` row is BLOCKED, not cascaded.
    pointUid: uuid("point_uid")
      .notNull()
      .references(() => points.id),
    ordinal: integer("ordinal").notNull(),
    // Config-v4 selection order. Unlike ordinal (which stabilizes the legacy KV subscriber index),
    // priority is scoped to one (area, role, metric) slot and survives cutover. Lowest wins.
    priority: integer("priority").notNull().default(0),
    transform: text("transform"), // per-binding override; null = inherit point_info.transform
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Re-based onto the uuid by 0047. Fully enforcing because `point_uid` is NOT NULL — had the
    // column stayed nullable, Postgres would treat two NULL-pointed bindings in the same slot as
    // distinct and the index would quietly stop constraining anything.
    bindingUnique: uniqueIndex("area_bindings_unique").on(
      table.areaId,
      table.role,
      table.metricType,
      table.pointUid,
    ),
    slotPriorityUnique: uniqueIndex("area_bindings_slot_priority_unique").on(
      table.areaId,
      table.role,
      table.metricType,
      table.priority,
    ),
    // The reverse "source point → the areas that bind it" lookup, on the uuid since 0047. Every
    // server-internal reader (lib/areas/config.ts, lib/coverage/runner.ts, …) probes it this way.
    pointIdx: index("area_bindings_point_idx").on(table.pointUid),
    areaIdx: index("area_bindings_area_idx").on(table.areaId),
    // config-v4 (Phase 4, migration 0032): enumerates the 6-role registry (lib/roles/registry.ts).
    // Added alongside the then-existing `roles` FK so that dropping the table would leave enforcement
    // intact — and since migration 0044 (slice G) dropped it, this CHECK is now the SOLE enforcement
    // of the role set. Keep it in step with `ROLES` by hand; nothing derives it. All 6 incl.
    // 'generator' (ROLE_IDS omits it, but this CHECK needs it).
    roleCheck: check(
      "area_bindings_role_check",
      sql`${table.role} IN ('solar','battery','load','grid','ev','generator')`,
    ),
  }),
);

// ============================================================================
// config-v4 Phase 4 — DARK, empty v4 tables (migration 0033).
//
// Pre-created behind the UNCHANGED v3 app so the cutover window's DDL shrinks to data transforms +
// a few FK-adds. Nothing reads or writes them until the cutover-era migrations/routes land. FKs are
// wired ONLY where the target already exists in its FINAL form (`areas.id` uuid; sibling new tables);
// FKs to points/devices/dashboards-as-uuid are DEFERRED to cutover (those tables / uuid PKs don't
// exist yet) and left as bare `uuid` columns. See docs/plans/config-v4-clean-sheet.md §4.4/§4.6/§11.
// ============================================================================

// derivations — the ONE mechanism for a derived signal (config-v4 Phase 11): config that computes a
// new signal from existing points. output='point' → a derived point in the readings pipeline (the
// HWS thermal model); output='intervals' → run/event periods in derived_intervals (run-tracking).
export const derivations = pgTable(
  "derivations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id),
    kind: text("kind").notNull(), // 'run-detector' | 'hws-model' | future kinds
    role: text("role"), // nullable; CHECK below (6 roles). NULL passes the CHECK (UNKNOWN ≠ FALSE).
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    output: text("output").notNull(), // CHECK ('point'|'intervals') below
    // FK → points(id): deferred at 0033 (points was empty), then WIRED by config-transform stage 5.
    // Declared here by migration 0036 — the constraint has been live since the cutover; leaving it
    // undeclared made drizzle want to DROP it on the next generate.
    outputPointId: uuid("output_point_id").references(() => points.id),
    params: jsonb("params").notNull(), // typed per kind: thresholds/hysteresis/delays | model constants
    sourcePoints: jsonb("source_points").notNull(), // typed point refs (signal, energy, …) by uuid
    detectorVersion: integer("detector_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      "derivations_role_check",
      sql`${table.role} IN ('solar','battery','load','grid','ev','generator')`,
    ),
    outputCheck: check(
      "derivations_output_check",
      sql`${table.output} IN ('point','intervals')`,
    ),
    // One derivation per (area, role) when role is set; role-less derivations are unconstrained.
    areaRoleUnique: uniqueIndex("derivations_area_role_unique")
      .on(table.areaId, table.role)
      .where(sql`role IS NOT NULL`),
    areaIdx: index("derivations_area_idx").on(table.areaId),
  }),
);

// derived_intervals (was device_run_periods): the output store for output='intervals' derivations.
// One row per coalesced run; end_time NULL = open (running now). Only FK is derivation_id (sibling).
export const derivedIntervals = pgTable(
  "derived_intervals",
  {
    // CASCADE (migration 0040): intervals are disposable derived output, fully reproducible from
    // the readings by a recompute — so they follow their derivation rather than blocking its
    // delete (which is also what makes the prod→dev sync's area idDrift cleanup safe).
    derivationId: uuid("derivation_id")
      .notNull()
      .references(() => derivations.id, { onDelete: "cascade" }),
    startTime: timestamp("start_time").notNull(), // UTC; immutable identity
    endTime: timestamp("end_time"), // UTC; NULL = OPEN (running now)
    durationSeconds: integer("duration_seconds"), // null while open
    energyKwh: doublePrecision("energy_kwh"),
    maxPowerW: doublePrecision("max_power_w"),
    minPowerW: doublePrecision("min_power_w"),
    avgPowerW: doublePrecision("avg_power_w"),
    // Per-run provenance, ACCUMULATED by the recompute exactly like energy_kwh — never derived at
    // render time. NULL = UNKNOWN, never zero: when the device's intensity is unknowable the
    // columns are omitted from the UI entirely (lib/run-tracking/intensity.ts). Named for their
    // units, deliberately not repeating the *_power_w mislabelling they sit beside.
    costC: doublePrecision("cost_c"), // cents (signed) — Σ sliceKwh × price(t)
    emissionsG: doublePrecision("emissions_g"), // grams CO₂ — Σ sliceKwh × intensity(t)
    renewableKwh: doublePrecision("renewable_kwh"), // kWh — Σ sliceKwh × renewableFraction(t)
    sampleCount: integer("sample_count").notNull().default(0),
    detectorVersion: integer("detector_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.derivationId, table.startTime] }),
    // At most ONE open interval per derivation (cf. drp_open_unique).
    openUnique: uniqueIndex("derived_intervals_open_unique")
      .on(table.derivationId)
      .where(sql`end_time IS NULL`),
  }),
);

// dashboard_revisions: cross-session undo — each whole-doc PUT (Phase-6 /api/v4) inserts a revision +
// bumps dashboards.revision. dashboard_id is bare uuid: the FK → dashboards(id) is DEFERRED to cutover
// (dashboards.id is serial int today; becomes uuid at cutover).
export const dashboardRevisions = pgTable(
  "dashboard_revisions",
  {
    // ⚠️ config-v4 CUTOVER SHAPE — the deferred FK → dashboards(id) is wired by transform stage 5d.
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    doc: jsonb("doc").notNull(),
    savedBy: text("saved_by").notNull(), // clerk user id
    savedAt: timestamp("saved_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.dashboardId, table.revision] }),
  }),
);

// legacy_handles: permanent compat shim mapping every old integer handle (systems.id AND
// areas.legacy_system_id) → its v4 uuid, so ?systemId=N resolves forever (area first, else device).
// Frozen at cutover. Both FKs are wired: area_id → areas(id) from the start, and device_id →
// devices(id) since config-transform stage 5 minted devices. The device FK was declared here by
// migration 0036 — it had been live but undeclared, so drizzle wanted to DROP it on the next generate.
export const legacyHandles = pgTable(
  "legacy_handles",
  {
    handle: integer("handle").primaryKey(), // old systems.id or areas.legacy_system_id
    deviceId: uuid("device_id").references(() => devices.id),
    areaId: uuid("area_id").references(() => areas.id),
  },
  (table) => ({
    deviceUnique: uniqueIndex("legacy_handles_device_unique")
      .on(table.deviceId)
      .where(sql`${table.deviceId} IS NOT NULL`),
    areaUnique: uniqueIndex("legacy_handles_area_unique")
      .on(table.areaId)
      .where(sql`${table.areaId} IS NOT NULL`),
  }),
);

// ============================================================================
// config-v4 registries (migration 0035, additive + DARK)
//
// These are the v4 successors to systems/point_info/area_devices/polling_status. Created EMPTY by
// 0035 and populated (idempotently) by scripts/config-v4/registry-sync.ts as a separate dark step.
// The predecessors are COPIED, not renamed, so both sets coexist until Phase 12 drops the old ones
// one at a time — which is what let the pre-cutover build keep running unchanged.
//
// No longer dark, and no longer a uniform group: `area_members` and `device_state` are now PRIMARY
// (slices H and C dropped/froze their predecessors), while `devices` and `points` are still mirrored
// from `systems`/`point_info` by lib/registry/v4-mirror.ts.
// ============================================================================

// Global device rid allocator. Seeded at max(systems.id)+1 by registry-sync so devices.rid preserves
// today's systems.id verbatim (sessions/observations_outbox keep an int device_rid == old system_id).
export const deviceRidSeq = pgSequence("device_rid_seq");

// devices ← systems. `id` is the pre-minted legacy_handles.device_id; `rid` is the old systems.id.
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey(),
    // Sequence-allocated (0043). ⚠️ INERT while `systems` still exists: systems_id_seq advances
    // independently, so a device minted from the default could later collide with a new systems.id
    // on devices_rid_unique. Every writer (ensureDeviceRow) must keep naming rid as systems.id
    // verbatim until Phase 12 slice N drops `systems` and re-asserts the setval.
    rid: integer("rid")
      .notNull()
      .default(sql`nextval('device_rid_seq')`),
    ownerUserId: text("owner_user_id"),
    vendor: text("vendor").notNull(), // ← systems.vendor_type
    vendorSiteId: text("vendor_site_id").notNull(),
    status: text("status").notNull().default("active"),
    name: text("name").notNull(), // ← systems.display_name
    slug: text("slug"), // ← systems.alias
    model: text("model"),
    serial: text("serial"),
    // Eager area: tz/location resolve HERE, not on the device. ⚠️ config-v4 CUTOVER SHAPE — NOT NULL
    // (registry-sync mints the area-of-one; the mint mirror ensureDeviceRow supplies it on every insert).
    primaryAreaId: uuid("primary_area_id")
      .notNull()
      .references(() => areas.id),
    config: jsonb("config").$type<DeviceConfig>(),
    adapterState: jsonb("adapter_state"), // ← systems.metadata
    commissionedOn: date("commissioned_on"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    ridUnique: uniqueIndex("devices_rid_unique").on(table.rid),
    statusCheck: check(
      "devices_status_check",
      sql`${table.status} IN ('active','disabled','removed')`,
    ),
    ownerSlugUnique: uniqueIndex("devices_owner_slug_unique").on(
      table.ownerUserId,
      table.slug,
    ),
  }),
);

// points ← point_info. `id` = point_info.point_uid and `rid` = point_info.rid, BOTH verbatim — the
// seam invariant the hot-table rid rewrite depends on.
export const points = pgTable(
  "points",
  {
    id: uuid("id").primaryKey(), // = point_info.point_uid
    // = point_info.rid, and DELIBERATELY the same sequence (0043): the two columns must stay equal,
    // so they must draw from one counter. LIVE since slice M — this DEFAULT is the sole allocator of
    // point identity; `mintPoint` reads the rid back from here and writes it into `point_info`.
    // (`mirrorPoint` still names rid explicitly, because it also serves `updatePoint`, which mirrors an
    // already-identified row.)
    rid: integer("rid")
      .notNull()
      .default(sql`nextval('point_rid_seq')`),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id),
    physicalPath: text("physical_path").notNull(), // ← point_info.physical_path_tail
    logicalPath: text("logical_path"), // ← point_info.logical_path_stem
    metricType: text("metric_type").notNull(),
    unit: text("unit").notNull(), // ← point_info.metric_unit
    name: text("name").notNull(), // ← point_info.display_name
    defaultName: text("default_name").notNull(), // ← point_info.point_name
    subsystem: text("subsystem"),
    transform: text("transform"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at"),
  },
  (table) => ({
    ridUnique: uniqueIndex("points_rid_unique").on(table.rid),
    devicePhysicalPathUnique: uniqueIndex(
      "points_device_physical_path_unique",
    ).on(table.deviceId, table.physicalPath),
    deviceLogicalMetricUnique: uniqueIndex(
      "points_device_logical_metric_unique",
    ).on(table.deviceId, table.logicalPath, table.metricType),
    deviceIdx: index("points_device_idx").on(table.deviceId),
  }),
);

// area_members — explicit area→member-device membership, and since Phase 12 slice H the ONLY one
// (it replaced `area_devices`, whose `system_id int` had no FK at all).
//
// Membership is first-class so an Area is uniformly "a grouping of 1..N member devices" and roles can
// DEFAULT from each member's own points (with `area_bindings` as an override) — there is no
// single-vs-multi special-case and no stored `kind`. An area-of-one has exactly one member.
//
// Two things carried over from the table this replaced:
//   • Fully rederivable, so the `area_id` CASCADE is safe and does NOT loosen
//     point_readings_flow_attr_1d's data-loss firewall (that table is untouched).
//   • The migration-0014 case still holds — a member whose `systems` row was deleted keeps its
//     membership, because `deleteSystem` ORPHANS its `devices` row rather than deleting it
//     (lib/systems-manager.ts, noted there as a known gap). That is what makes a hard `device_id` FK
//     satisfiable where the old int deliberately had none. If that gap is ever closed, the CASCADE
//     here means such a member silently leaves its areas — fix the two together.
export const areaMembers = pgTable(
  "area_members",
  {
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.areaId, table.deviceId],
      name: "area_members_pk",
    }),
  }),
);

// device_state ← polling_status. 1:1 operational satellite of devices; written every poll, and since
// Phase 12 slice C the ONLY operational-state table (polling_status is frozen — see its header).
export const deviceState = pgTable("device_state", {
  deviceId: uuid("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  lastPollTime: timestamp("last_poll_time"),
  lastSuccessTime: timestamp("last_success_time"),
  lastErrorTime: timestamp("last_error_time"),
  lastError: text("last_error"),
  lastResponse: jsonb("last_response"),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  totalPolls: integer("total_polls").notNull().default(0),
  successfulPolls: integer("successful_polls").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================================
// Type exports
// ============================================================================
export type System = typeof systems.$inferSelect;
export type NewSystem = typeof systems.$inferInsert;
// NB `DeviceRow`/`PointRow`, not `Device`/`Point`: `lib/ids` already exports `Device` and `Point` as
// the TypeID codecs (`Device.encode(...)`), and the seam/registry modules import both.
export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
export type PointRow = typeof points.$inferSelect;
export type NewPointRow = typeof points.$inferInsert;
export type AreaMember = typeof areaMembers.$inferSelect;
export type NewAreaMember = typeof areaMembers.$inferInsert;
export type DeviceState = typeof deviceState.$inferSelect;
export type NewDeviceState = typeof deviceState.$inferInsert;
export type PollingStatus = typeof pollingStatus.$inferSelect;
export type NewPollingStatus = typeof pollingStatus.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type PointInfo = typeof pointInfo.$inferSelect;
export type NewPointInfo = typeof pointInfo.$inferInsert;
export type PointReading = typeof pointReadings.$inferSelect;
export type NewPointReading = typeof pointReadings.$inferInsert;
export type PointReadingAgg5m = typeof pointReadingsAgg5m.$inferSelect;
export type NewPointReadingAgg5m = typeof pointReadingsAgg5m.$inferInsert;
export type PointReadingAgg1d = typeof pointReadingsAgg1d.$inferSelect;
export type NewPointReadingAgg1d = typeof pointReadingsAgg1d.$inferInsert;
export type PointReadingFlowAttr1d =
  typeof pointReadingsFlowAttr1d.$inferSelect;
export type NewPointReadingFlowAttr1d =
  typeof pointReadingsFlowAttr1d.$inferInsert;
export type ShareToken = typeof shareTokens.$inferSelect;
export type NewShareToken = typeof shareTokens.$inferInsert;
export type ObservationsOutbox = typeof observationsOutbox.$inferSelect;
export type NewObservationsOutbox = typeof observationsOutbox.$inferInsert;
export type Dashboard = typeof dashboards.$inferSelect;
export type NewDashboard = typeof dashboards.$inferInsert;
export type Area = typeof areas.$inferSelect;
export type NewArea = typeof areas.$inferInsert;
export type AreaBinding = typeof areaBindings.$inferSelect;
export type NewAreaBinding = typeof areaBindings.$inferInsert;
export type Derivation = typeof derivations.$inferSelect;
export type NewDerivation = typeof derivations.$inferInsert;
export type DerivedInterval = typeof derivedIntervals.$inferSelect;
export type NewDerivedInterval = typeof derivedIntervals.$inferInsert;
export type DashboardRevision = typeof dashboardRevisions.$inferSelect;
export type NewDashboardRevision = typeof dashboardRevisions.$inferInsert;
export type LegacyHandle = typeof legacyHandles.$inferSelect;
export type NewLegacyHandle = typeof legacyHandles.$inferInsert;
