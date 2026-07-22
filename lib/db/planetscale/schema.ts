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
  foreignKey,
  timestamp,
  date,
  pgSequence,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";
import type { DeviceConfig } from "@/lib/capabilities/config";

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
// Polling Status table - track health and errors
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

// ============================================================================
// User-System junction table for many-to-many relationship
// ============================================================================
export const userSystems = pgTable(
  "user_systems",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userSystemUnique: uniqueIndex("user_system_unique").on(
      table.clerkUserId,
      table.systemId,
    ),
    userIdx: index("user_systems_user_idx").on(table.clerkUserId),
    systemIdx: index("user_systems_system_idx").on(table.systemId),
  }),
);

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
    defaultDashboardId: integer("default_dashboard_id").references(
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
    // (system_id, id) ADDRESS and all composite FKs are untouched. Auto-filled by the DB DEFAULT, so
    // writers must NEVER name it in insert .values(...); introduce no max(rid)+1 pattern.
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
    id: serial("id").primaryKey(),

    // Relationships
    systemId: integer("system_id").notNull(),
    pointId: integer("point_id").notNull(),
    // Session id is text (UUIDv7 / stringified-int historical). FK to
    // sessions(id) is enforced (added in PR-7b after co-enqueue guarantees the
    // session row lands before its readings). NULL session_id is allowed.
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

    // When this row was ingested into Postgres (the queue consumer leaves this to
    // defaultNow). Distinct from measurementTime/receivedTime — used to chart the
    // true ingestion rate, and to distinguish live ingestion from later backfills.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    pointTimeUnique: uniqueIndex("pr_point_time_unique").on(
      table.systemId,
      table.pointId,
      table.measurementTime,
    ),
    systemTimeIdx: index("pr_system_time_idx").on(
      table.systemId,
      table.measurementTime,
    ),
    measurementTimeIdx: index("pr_measurement_time_idx").on(
      table.measurementTime,
    ),
    createdAtIdx: index("pr_created_at_idx").on(table.createdAt),
    pointInfoFk: foreignKey({
      columns: [table.systemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
      name: "point_readings_system_id_point_id_point_info_fk",
    }),
  }),
);

// ============================================================================
// 5-minute aggregation table
// ============================================================================
export const pointReadingsAgg5m = pgTable(
  "point_readings_agg_5m",
  {
    // Composite primary key columns
    systemId: integer("system_id").notNull(),
    pointId: integer("point_id").notNull(),
    intervalEnd: timestamp("interval_end").notNull(),

    // Optional session tracking (text: UUIDv7 / stringified-int historical)
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
      columns: [table.systemId, table.pointId, table.intervalEnd],
    }),
    systemTimeIdx: index("pr5m_system_time_idx").on(
      table.systemId,
      table.intervalEnd,
    ),
    intervalEndIdx: index("pr5m_interval_end_idx").on(table.intervalEnd),
    createdAtIdx: index("pr5m_created_at_idx").on(table.createdAt),
    // Watermark column for the incremental prod→dev sync (sync-prod-to-dev-db.ts): the export
    // filters `WHERE updated_at > <wm>`, which seq-scanned the whole ~3M-row table without this.
    updatedAtIdx: index("pr5m_updated_at_idx").on(table.updatedAt),
    pointInfoFk: foreignKey({
      columns: [table.systemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
      name: "point_readings_agg_5m_system_id_point_id_point_info_fk",
    }),
  }),
);

// ============================================================================
// Daily aggregation table
// ============================================================================
export const pointReadingsAgg1d = pgTable(
  "point_readings_agg_1d",
  {
    // Composite primary key columns
    systemId: integer("system_id").notNull(),
    pointId: integer("point_id").notNull(),
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
    pk: primaryKey({ columns: [table.systemId, table.pointId, table.day] }),
    systemDayIdx: index("pr1d_system_day_idx").on(table.systemId, table.day),
    dayIdx: index("pr1d_day_idx").on(table.day),
    pointInfoFk: foreignKey({
      columns: [table.systemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
      name: "point_readings_agg_1d_system_id_point_id_point_info_fk",
    }),
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
export const shareTokens = pgTable(
  "share_tokens",
  {
    token: text("token").primaryKey(), // 3-word phrase, e.g. "leaping-fizzy-wombat"
    ownerClerkUserId: text("owner_clerk_user_id").notNull(),
    label: text("label"),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    expiresAtMs: bigint("expires_at_ms", { mode: "number" }),
    revokedAtMs: bigint("revoked_at_ms", { mode: "number" }),
    lastUsedAtMs: bigint("last_used_at_ms", { mode: "number" }),
  },
  (table) => ({
    ownerIdx: index("share_tokens_owner_idx").on(table.ownerClerkUserId),
  }),
);

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
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(), // the owner
    // A dashboard's name + owner-unique shortname (the /dashboard/{user}/{alias} path). Nullable for
    // an unnamed dashboard. The legacy per-system `system_id`/`area_id` handles were dropped in P6 —
    // a dashboard is a v3 composition whose sections each carry their own Area uuid.
    displayName: text("display_name"),
    alias: text("alias"), // owner-unique shortname for /dashboard/{user}/{alias}; null = unnamed
    descriptor: jsonb("descriptor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // (clerk_user_id, alias) unique — owner-scoped shortname (NULL aliases distinct).
    ownerAliasUnique: uniqueIndex("dashboards_owner_alias_unique").on(
      table.clerkUserId,
      table.alias,
    ),
    userIdx: index("dashboards_user_idx").on(table.clerkUserId),
  }),
);

// ============================================================================
// Dashboard share tokens (P4) - read-only public links scoped to ONE dashboard.
//
// Distinct from the legacy `share_tokens` (which is owner-scoped to all the owner's systems and has
// no GET consumption). A holder of a valid token gets read access to exactly the points that
// dashboard's data exposes (resolved Dashboard → Area → area_bindings; see lib/dashboard/access.ts),
// never general system access. Same 3-word phrase + epoch-ms convention as `share_tokens`.
// ============================================================================
export const dashboardShareTokens = pgTable(
  "dashboard_share_tokens",
  {
    token: text("token").primaryKey(), // 3-word phrase, e.g. "leaping-fizzy-wombat"
    dashboardId: integer("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    label: text("label"),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    expiresAtMs: bigint("expires_at_ms", { mode: "number" }),
    revokedAtMs: bigint("revoked_at_ms", { mode: "number" }),
    lastUsedAtMs: bigint("last_used_at_ms", { mode: "number" }),
  },
  (table) => ({
    dashboardIdx: index("dashboard_share_tokens_dashboard_idx").on(
      table.dashboardId,
    ),
  }),
);

// ============================================================================
// Dashboard grants (P4) - per-dashboard membership (invite a person to a dashboard).
// Access resolves Dashboard → its cards' bindings → points, so a grant is read-scoped to exactly
// what the dashboard shows. role ∈ owner|admin|viewer. (Grant-management UI is a later phase.)
// ============================================================================
export const dashboardGrants = pgTable(
  "dashboard_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: integer("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    role: text("role").notNull(), // 'owner' | 'admin' | 'viewer'
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  },
  (table) => ({
    dashboardUserUnique: uniqueIndex(
      "dashboard_grants_dashboard_user_unique",
    ).on(table.dashboardId, table.clerkUserId),
    userIdx: index("dashboard_grants_user_idx").on(table.clerkUserId),
  }),
);

export type DashboardGrant = typeof dashboardGrants.$inferSelect;
export type NewDashboardGrant = typeof dashboardGrants.$inferInsert;

// ============================================================================
// Roles - HA-device_class-aware role registry (P3). A SQL projection of the code
// source of truth in lib/roles/registry.ts (ROLES). Seeded/kept-in-sync by the
// backfill script; exists so area_bindings.role has a FK target and so SQL joins
// (Sankey side, HA export) can read role metadata without the code registry.
// Do NOT hand-edit role data here — change lib/roles/registry.ts and re-seed.
// ============================================================================
export const roles = pgTable("roles", {
  role: text("role").primaryKey(), // RoleId: 'solar' | 'battery' | 'load' | 'grid' | 'ev'
  category: text("category").notNull(), // 'source' | 'load' | 'bidi'
  stem: text("stem").notNull(), // anchor logical_path_stem, e.g. 'source.solar' | 'bidi.battery'
  label: text("label").notNull(),
  haDeviceClass: text("ha_device_class").notNull(), // 'power' | 'battery' ...
  haStateClass: text("ha_state_class").notNull(), // 'measurement' | 'total' | 'total_increasing'
  haUnit: text("ha_unit").notNull(), // 'W' | '%'
  summaryMetric: text("summary_metric"), // 'power' | 'soc' — null = not summarised (ev)
  summaryAggregable: boolean("summary_aggregable"), // null when not summarised
});

// ============================================================================
// Areas - the SEMANTIC layer (P3). A named role-set that binds physical points
// into a coherent energy site. Replaced vendor_type='composite' fake systems rows.
//
// An Area is a grouping of 1..N member devices (`area_devices`):
//   area-of-one   → 1:1 wrapper over a single physical system (its sole `area_devices` member).
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
    ownerClerkUserId: text("owner_clerk_user_id"),
    // The 1:1 migration seam + the stable integer ADDRESSING HANDLE. For a multi-device area it is
    // the old composite shim's systems.id; no FK to systems, since that area outlives its `systems`
    // row (deleted in migration 0014), and `getSystem(legacy_system_id)` then resolves to the
    // synthesized virtual system. The unique index below stays as the addressing invariant (one Area
    // per handle).
    legacySystemId: integer("legacy_system_id"),
    displayName: text("display_name").notNull(),
    alias: text("alias"),
    timezoneOffsetMin: integer("timezone_offset_min").notNull(),
    displayTimezone: text("display_timezone").notNull(),
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
    aliasUnique: uniqueIndex("areas_owner_alias_unique").on(
      table.ownerClerkUserId,
      table.alias,
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
// The (point_system_id, point_id) index IS the KV subscription registry's reverse
// lookup (source point → composites that subscribe), now in SQL.
// ============================================================================
export const areaBindings = pgTable(
  "area_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    role: text("role")
      .notNull()
      .references(() => roles.role),
    metricType: text("metric_type").notNull(), // from point_info: 'power' | 'soc' | 'energy' | 'rate' ...
    pointSystemId: integer("point_system_id").notNull(), // the CHILD physical system
    pointId: integer("point_id").notNull(), // (point_system_id, point_id) → point_info(system_id, id)
    ordinal: integer("ordinal").notNull(),
    transform: text("transform"), // per-binding override; null = inherit point_info.transform
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    bindingUnique: uniqueIndex("area_bindings_unique").on(
      table.areaId,
      table.role,
      table.metricType,
      table.pointSystemId,
      table.pointId,
    ),
    pointIdx: index("area_bindings_point_idx").on(
      table.pointSystemId,
      table.pointId,
    ),
    areaIdx: index("area_bindings_area_idx").on(table.areaId),
    pointFk: foreignKey({
      columns: [table.pointSystemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
      name: "area_bindings_point_info_fk",
    }),
  }),
);

// ============================================================================
// Area devices - explicit area→member-device membership (the unified 1..N model, Phase B).
//
// Unifies the two implicit membership models into one: an area-of-one has a single member (its
// `source_system_id`); a multi-device area's members are the DISTINCT `area_bindings.point_system_id`s.
// Making membership first-class lets an Area be "a grouping of 1..N member devices" and lets roles
// DEFAULT from each member's own point_info (with area_bindings as an override) — so there is no
// single-vs-multi special-case. `system_id` is a plain int (like `areas.legacy_system_id`) with NO FK to
// systems: a member may be a child system whose `systems` row was deleted (migration 0014). The table
// is fully rederivable, so the `area_id` CASCADE is safe and does NOT loosen point_readings_flow_attr_1d's
// data-loss firewall (that table is untouched).
// ============================================================================
export const areaDevices = pgTable(
  "area_devices",
  {
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    systemId: integer("system_id").notNull(),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.areaId, table.systemId] }),
  }),
);

// ============================================================================
// Device trackers - per-instance run-tracking config (run-tracking feature).
//
// One tracker per (system, role) defines how to recognise "running" for a device: an HA-style
// threshold helper over a chosen power point (lower/upper bound + hysteresis deadband) plus
// anti-flap delays (delay_on/delay_off). The signal + energy points are referenced explicitly
// (decision: "choose any power point"), independent of area_bindings.
// Null behaviour columns inherit per-role code defaults (lib/run-tracking/defaults.ts).
// `system_id` is the logical system (== areas.legacy_system_id seam); `area_id` is a nullable
// forward-only seam to be backfilled when areas-of-one land. See docs (run-tracking).
// ============================================================================
export const deviceTrackers = pgTable(
  "device_trackers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    systemId: integer("system_id").notNull(), // logical system observed
    role: text("role")
      .notNull()
      .references(() => roles.role), // 'generator' ...
    areaId: uuid("area_id").references(() => areas.id), // forward-only seam (nullable)
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),

    // Signal: a power point + HA-style threshold bounds. ≥1 of lower/upper set; direction is
    // implicit (generator: lowerW = -50 ⇒ on when value < -50).
    signalKind: text("signal_kind").notNull().default("power-threshold"),
    signalSystemId: integer("signal_system_id").notNull(), // child system for composites
    signalPointId: integer("signal_point_id").notNull(),
    lowerW: doublePrecision("lower_w"), // HA threshold `lower` (on when below)
    upperW: doublePrecision("upper_w"), // HA threshold `upper` (on when above)
    hysteresisW: doublePrecision("hysteresis_w"), // HA deadband (±); null = inherit default

    // Energy attribution (optional). Generator: the 'Import' energy point.
    energySystemId: integer("energy_system_id"),
    energyPointId: integer("energy_point_id"),

    // Anti-flap (HA binary_sensor vocabulary; null = inherit per-role code default).
    delayOnSeconds: integer("delay_on_seconds"), // min run; shorter spans dropped
    delayOffSeconds: integer("delay_off_seconds"), // coalesce gap / close-after-off
    detectorVersion: integer("detector_version").notNull().default(1),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    systemRoleUnique: uniqueIndex("device_trackers_system_role_unique").on(
      table.systemId,
      table.role,
    ),
    signalPointFk: foreignKey({
      columns: [table.signalSystemId, table.signalPointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
      name: "device_trackers_signal_point_fk",
    }),
  }),
);

// ============================================================================
// Device run periods - the run-tracking serving store (run-tracking feature).
//
// Each row is one coalesced run of a device: start_time..end_time, end NULL = OPEN (running now).
// This IS the binary "running" entity's edge-compressed history (the HA logbook); the live state
// is the open row. Keyed by (system_id, role, start_time) — start_time is immutable once detected
// (end_time mutates), so it is the stable identity across recomputes (cf. agg_5m keying on
// interval_end). The recompute does a bounded delete-and-reinsert per (system, role) window, so a
// run whose boundaries shift (split/merge/earlier-start under backfill) resolves without orphans.
// Metrics are columns (energy/min/max/avg power) so the API never does per-period sub-queries.
// `area_id` is the forward-only Areas re-key seam (never the key). See docs (run-tracking).
// ============================================================================
export const deviceRunPeriods = pgTable(
  "device_run_periods",
  {
    systemId: integer("system_id").notNull(), // logical system (== legacy_system_id seam)
    role: text("role")
      .notNull()
      .references(() => roles.role),
    startTime: timestamp("start_time").notNull(), // UTC, run start
    endTime: timestamp("end_time"), // UTC; NULL = OPEN (running now)

    // Provenance: which point produced the signal (child system for a composite).
    signalSystemId: integer("signal_system_id").notNull(),
    signalPointId: integer("signal_point_id").notNull(),
    trackerId: uuid("tracker_id").references(() => deviceTrackers.id), // traceability (nullable)
    areaId: uuid("area_id").references(() => areas.id), // forward-only seam

    // Stored metrics (computed once; bounded reads, never N+1). Power values are signed raw W.
    durationSeconds: integer("duration_seconds"), // null while open
    energyKwh: doublePrecision("energy_kwh"), // kWh 3dp; null if no energy point / unknown
    maxPowerW: doublePrecision("max_power_w"),
    minPowerW: doublePrecision("min_power_w"),
    avgPowerW: doublePrecision("avg_power_w"),
    sampleCount: integer("sample_count").notNull().default(0),

    detectorVersion: integer("detector_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.systemId, table.role, table.startTime],
    }),
    // At most ONE open period per (system, role) — enforced, not hoped (cf. observations_outbox
    // unpublished partial index). Powers the O(1) "is it running now?" lookup.
    openUnique: uniqueIndex("drp_open_unique")
      .on(table.systemId, table.role)
      .where(sql`end_time IS NULL`),
    signalPointFk: foreignKey({
      columns: [table.signalSystemId, table.signalPointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
      name: "device_run_periods_signal_point_fk",
    }),
  }),
);

// ============================================================================
// Type exports
// ============================================================================
export type System = typeof systems.$inferSelect;
export type NewSystem = typeof systems.$inferInsert;
export type PollingStatus = typeof pollingStatus.$inferSelect;
export type NewPollingStatus = typeof pollingStatus.$inferInsert;
export type UserSystem = typeof userSystems.$inferSelect;
export type NewUserSystem = typeof userSystems.$inferInsert;
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
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Area = typeof areas.$inferSelect;
export type NewArea = typeof areas.$inferInsert;
export type AreaBinding = typeof areaBindings.$inferSelect;
export type NewAreaBinding = typeof areaBindings.$inferInsert;
export type DeviceTracker = typeof deviceTrackers.$inferSelect;
export type NewDeviceTracker = typeof deviceTrackers.$inferInsert;
export type DeviceRunPeriod = typeof deviceRunPeriods.$inferSelect;
export type NewDeviceRunPeriod = typeof deviceRunPeriods.$inferInsert;
