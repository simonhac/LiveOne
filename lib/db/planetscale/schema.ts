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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";

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
    timezoneOffsetMin: integer("timezone_offset_min").notNull(),
    displayTimezone: text("display_timezone").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    ownerClerkUserIdx: index("owner_clerk_user_idx").on(table.ownerClerkUserId),
    statusIdx: index("systems_status_idx").on(table.status),
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
    // Plain integer view handle (no FK to systems): a user may default to a composite, whose
    // areas-backed virtual system has no `systems` row after migration 0014. Resolved via
    // getSystem(default_system_id).
    defaultSystemId: integer("default_system_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    defaultSystemIdx: index("users_default_system_idx").on(
      table.defaultSystemId,
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
export const pointInfo = pgTable(
  "point_info",
  {
    // Composite primary key (systemId, index)
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id),
    index: integer("id").notNull(), // Sequential per system

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
// Energy-flow matrix — per local-day, per (source, load) directional energy.
//
// Built by the engine from `point_readings_agg_5m` (NOT from `agg_1d`, whose
// daily avg cancels bidirectional direction — that cancellation is the whole bug
// this table fixes). Energy is ALWAYS >= 0; direction is encoded by which slot a
// flow lands in: battery charge -> load.battery, discharge -> source.battery;
// grid import -> source.grid, export -> load.grid. Path-keyed (not point-keyed)
// so aggregated solar (one node for many points) and the synthetic
// `load.rest-of-house` have a stable identity; labels/colors resolve at read
// time. A multi-day range is a plain `SUM(energy_kwh) GROUP BY (source_path,
// load_path)`, because per-interval energy is additive.
//
// `area_id` is the LOGICAL SYSTEM / view the flows belong to (`resolveLogicalSystem`):
// an identity Area over a single physical system, OR a composite Area whose points are drawn
// from CHILD systems. For a composite the cross-system origin is collapsed into the Area
// (provenance is not preserved on the row); `source_path`/`load_path` are stems in that view's
// namespace. All flows in a row therefore belong to one view — cross-system *edges* (a source
// on one system, a load on another) are not representable in this shape. NOTE: a composite Area
// and its members' identity Areas each get their own rows, so a portfolio rollup must never sum
// a composite AND its members.
// ============================================================================
export const pointReadingsFlow1d = pgTable(
  "point_readings_flow_1d",
  {
    // The Area this view belongs to — the logical-system identity (P3-tail-1). Part of the
    // composite primary key. An identity Area is a 1:1 wrapper over a single physical system; a
    // composite Area collapses its members' provenance into one namespace. See
    // areas-and-dashboards.md (P3). (Replaced the legacy `system_id` keying in migration 0013.)
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id),
    day: text("day").notNull(), // YYYY-MM-DD, system-local — same key convention as agg_1d
    sourcePath: text("source_path").notNull(), // e.g. "source.solar" | "source.battery" | "source.grid"
    loadPath: text("load_path").notNull(), // "load" | "load.<sub>" | "load.battery" | "load.grid" | "load.rest-of-house"

    // Flow value
    energyKwh: doublePrecision("energy_kwh").notNull(), // always >= 0

    // Data quality / provenance
    sampleCount: integer("sample_count").notNull(), // # of 5m intervals that contributed
    version: integer("version").notNull().default(1), // algorithm version → lets backfill detect stale rows

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.areaId, table.day, table.sourcePath, table.loadPath],
    }),
    dayIdx: index("prf1d_day_idx").on(table.day),
    areaDayIdx: index("prf1d_area_day_idx").on(table.areaId, table.day),
  }),
);

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
// see docs/architecture/engine-web-separation.md §6.4. Gated by WRITE_OUTBOX; written
// in parallel with (a tee of) the live direct enqueue during the soak.
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
// Dashboards - per-user, per-system presentation layer (P2).
//
// One row per (user, system): the user's forked/customized DashboardDescriptor
// (card order + hidden flags), stored as JSONB. Absent row → the dashboard is
// auto-generated from buildDefaultDescriptor (lib/dashboard). The descriptor's
// internal shape is owned by lib/dashboard and intentionally opaque to the DB.
// See docs/architecture/areas-and-dashboards.md. Normalising into a separate
// `dashboard_cards` table is deferred to P3.
//
// `area_id` (P3, additive/forward-only) links the dashboard to the Area that is its
// data context — the system's identity Area, or a composite Area. Resolved server-side
// from `system_id` on save (1:1 today, so it changes no behaviour); NULL when AREAS_TABLE
// is off / not yet backfilled. `(clerk_user_id, system_id)` stays the authoritative access
// key through the soak; this column is the seam P4 (multiple named dashboards per Area +
// per-dashboard sharing) rotates on. ON DELETE SET NULL so dropping an Area never deletes a
// user's customization.
// ============================================================================
export const dashboards = pgTable(
  "dashboards",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    // Plain integer view handle (no FK to systems): a composite dashboard's system_id is its
    // areas-backed virtual-system id, which has no `systems` row after migration 0014. `area_id` is
    // the forward seam; `(clerk_user_id, system_id)` stays the access/uniqueness key.
    systemId: integer("system_id").notNull(),
    areaId: uuid("area_id").references(() => areas.id, {
      onDelete: "set null",
    }),
    descriptor: jsonb("descriptor").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userSystemUnique: uniqueIndex("dashboards_user_system_unique").on(
      table.clerkUserId,
      table.systemId,
    ),
    userIdx: index("dashboards_user_idx").on(table.clerkUserId),
    areaIdx: index("dashboards_area_idx").on(table.areaId),
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
// into a coherent energy site. Replaces vendor_type='composite' fake systems rows.
//
//   kind='identity'  → 1:1 wrapper over a single physical system (source_system_id).
//   kind='composite' → bindings drawn from points across ≥2 systems.
//
// `id` is a GUID (decoupled from systems.id). `legacy_system_id` is the systems.id
// this Area was migrated from (identity: == source_system_id; composite: the composite
// shim row) — it is the 1:1 seam that drives the point_readings_flow_1d.area_id re-key
// and keeps the composite shim joined through the soak. Droppable post-soak.
// Areas are organizational, NOT the access boundary (access stays system-granular until P4).
// ============================================================================
export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(), // app supplies uuidv7(); default is a safety net
    ownerClerkUserId: text("owner_clerk_user_id"),
    kind: text("kind").notNull(), // 'identity' | 'composite'
    sourceSystemId: integer("source_system_id").references(() => systems.id), // set for kind='identity'
    // The 1:1 migration seam + the stable integer ADDRESSING HANDLE for a composite (its old
    // systems.id). No FK to systems: a composite Area outlives its `systems` row (deleted in
    // migration 0014), and `getSystem(legacy_system_id)` then resolves to the synthesized virtual
    // system. The unique index below stays as the addressing invariant (one Area per handle).
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
    sourceSystemIdx: index("areas_source_system_idx").on(table.sourceSystemId),
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
// Device trackers - per-instance run-tracking config (run-tracking feature).
//
// One tracker per (system, role) defines how to recognise "running" for a device: an HA-style
// threshold helper over a chosen power point (lower/upper bound + hysteresis deadband) plus
// anti-flap delays (delay_on/delay_off). The signal + energy points are referenced explicitly
// (decision: "choose any power point"), independent of area_bindings / the AREAS_TABLE flag.
// Null behaviour columns inherit per-role code defaults (lib/run-tracking/defaults.ts).
// `system_id` is the logical system (== areas.legacy_system_id seam); `area_id` is a nullable
// forward-only seam to be backfilled when identity Areas land. See docs (run-tracking).
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
export type PointReadingFlow1d = typeof pointReadingsFlow1d.$inferSelect;
export type NewPointReadingFlow1d = typeof pointReadingsFlow1d.$inferInsert;
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
