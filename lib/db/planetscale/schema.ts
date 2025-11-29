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
  integer,
  text,
  doublePrecision,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";

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
    id: serial("id").primaryKey(),
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
    // Unique constraint for dedup during queue processing
    systemCreatedAtUnique: uniqueIndex("sessions_system_created_at_unique").on(
      table.systemId,
      table.createdAt,
    ),
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
    sessionId: integer("session_id"),

    // Timestamps (UTC)
    measurementTime: timestamp("measurement_time").notNull(),
    receivedTime: timestamp("received_time").notNull(),

    // Core measurements
    value: doublePrecision("value"),
    valueStr: text("value_str"),

    // Quality & status
    error: text("error"),
    dataQuality: text("data_quality").notNull().default("good"),
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

    // Optional session tracking
    sessionId: integer("session_id"),

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
