/**
 * PlanetScale PostgreSQL Schema
 *
 * PostgreSQL version of the full database schema.
 * Uses drizzle-orm/pg-core for PostgreSQL types.
 *
 * ## SQLite vs PostgreSQL Schema Comparison
 *
 * | Aspect              | SQLite (Turso)                    | PostgreSQL (PlanetScale)         |
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
 * 3. **Foreign Keys**: Not defined here - tables are standalone for queue receiver.
 *    The receiver inserts data without FK validation for performance.
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
  doublePrecision,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    systemId: integer("system_id").notNull(),
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
    systemId: integer("system_id").notNull(),
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
    systemId: integer("system_id").notNull(),
    cause: text("cause").notNull(),
    duration: integer("duration").notNull(), // milliseconds
    successful: boolean("successful"),
    errorCode: text("error_code"),
    error: text("error"),
    response: jsonb("response"),
    numRows: integer("num_rows").notNull(),
    // Migration: import from turso.sessions.started
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
    systemId: integer("system_id").notNull(),
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
// `system_id` is the LOGICAL SYSTEM / view the flows belong to (`resolveLogicalSystem`):
// a single physical system, OR a composite whose points are drawn from CHILD systems.
// For a composite the cross-system origin is collapsed into the composite's id (provenance
// is not preserved on the row); `source_path`/`load_path` are stems in that view's namespace.
// All flows in a row therefore belong to one view — cross-system *edges* (a source on one
// system, a load on another) are not representable in this shape. NOTE: a composite and its
// child systems each get their own rows, so a portfolio rollup must never sum a composite
// AND its members.
// ============================================================================
export const pointReadingsFlow1d = pgTable(
  "point_readings_flow_1d",
  {
    // Composite primary key columns
    systemId: integer("system_id").notNull(), // LOGICAL system / view id (physical OR composite)
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
      columns: [table.systemId, table.day, table.sourcePath, table.loadPath],
    }),
    systemDayIdx: index("prf1d_system_day_idx").on(table.systemId, table.day),
    dayIdx: index("prf1d_day_idx").on(table.day),
  }),
);

// ============================================================================
// Share tokens - view-only access links scoped to systems owned by the token's owner
// (mirrors Turso `share_tokens`). Epoch-ms columns use bigint(mode:"number") so
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
// published once accepted. This makes raw durability live on Postgres without
// relying on the inline Turso write — see docs/architecture/engine-web-separation.md
// §6.4 and docs/turso-pg-migration.md Phase 4. Gated by WRITE_OUTBOX; written in
// parallel with (a tee of) the live direct enqueue during the soak.
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
