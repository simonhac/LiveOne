import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Systems table - stores inverter system information
export const systems = sqliteTable(
  "systems",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerClerkUserId: text("owner_clerk_user_id"), // Clerk user ID of the owner who holds the vendor credentials
    vendorType: text("vendor_type").notNull(), // Vendor type (e.g., 'selectronic', 'fronius', 'sma')
    vendorSiteId: text("vendor_site_id").notNull(), // Vendor's site/system identifier
    status: text("status").notNull().default("active"), // 'active', 'disabled', or 'removed'
    displayName: text("display_name").notNull(),
    alias: text("alias"), // Optional alias (letters, digits, underscore only) - used in history API IDs and as URL-friendly identifier
    model: text("model"),
    serial: text("serial"),
    ratings: text("ratings"),
    solarSize: text("solar_size"),
    batterySize: text("battery_size"),
    location: text("location", { mode: "json" }), // JSON object for address, city/state/country, or lat/lon
    metadata: text("metadata", { mode: "json" }), // JSON object for vendor-specific config (e.g., composite system sources)
    timezoneOffsetMin: integer("timezone_offset_min").notNull(), // Standard timezone offset in minutes (e.g., 600 for AEST/UTC+10, DST calculated separately) - set by code at creation
    displayTimezone: text("display_timezone").notNull(), // IANA timezone string for display (e.g., 'Australia/Melbourne') - observes DST
    isDefault: integer("is_default").notNull().default(0).$type<0 | 1>(), // User's default system (0 or 1) - enforced by partial unique index
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    // Note: vendor_site_unique index removed to allow multiple systems with same vendorSiteId (e.g., for removed/inactive systems)
    ownerClerkUserIdx: index("owner_clerk_user_idx").on(table.ownerClerkUserId),
    statusIdx: index("systems_status_idx").on(table.status),
    // Unique constraint for alias per user (only when not null)
    aliasUnique: uniqueIndex("alias_unique").on(
      table.ownerClerkUserId,
      table.alias,
    ),
    // Partial unique index: only one default system per owner
    isDefaultUnique: uniqueIndex("is_default_unique")
      .on(table.ownerClerkUserId)
      .where(sql`${table.isDefault} = 1`),
  }),
);

// API polling status table - track health and errors
export const pollingStatus = sqliteTable(
  "polling_status",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    lastPollTime: integer("last_poll_time", { mode: "timestamp" }),
    lastSuccessTime: integer("last_success_time", { mode: "timestamp" }),
    lastErrorTime: integer("last_error_time", { mode: "timestamp" }),
    lastError: text("last_error"),
    lastResponse: text("last_response", { mode: "json" }), // Store full Select.Live response
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    totalPolls: integer("total_polls").notNull().default(0),
    successfulPolls: integer("successful_polls").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    systemIdx: index("polling_system_idx").on(table.systemId),
    systemIdUnique: uniqueIndex("polling_status_system_id_unique").on(
      table.systemId,
    ),
  }),
);

// User-System junction table for many-to-many relationship
export const userSystems = sqliteTable(
  "user_systems",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clerkUserId: text("clerk_user_id").notNull(),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"), // 'owner', 'admin', 'viewer'
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
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

// Sessions table - tracks all communication sessions with energy systems
// Note: vendorType and systemName removed in migration 0054 - use JOIN with systems table instead
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionLabel: text("session_label"), // nullable - provided by remote system if available
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    cause: text("cause").notNull(), // 'POLL', 'ADMIN', 'USER', etc.
    started: integer("started", { mode: "timestamp" }).notNull(),
    duration: integer("duration").notNull(), // milliseconds
    successful: integer("successful", { mode: "boolean" }), // Nullable: NULL=pending, true=success, false=failed
    errorCode: text("error_code"), // nullable - short error code/number
    error: text("error"), // nullable - detailed error message
    response: text("response", { mode: "json" }), // nullable - full server response as JSON
    numRows: integer("num_rows").notNull(), // 0 if no data rows, otherwise count
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    systemIdx: index("sessions_system_idx").on(table.systemId),
    startedIdx: index("sessions_started_idx").on(table.started),
    causeIdx: index("sessions_cause_idx").on(table.cause),
  }),
);

// Type exports for TypeScript
export type System = typeof systems.$inferSelect;
export type NewSystem = typeof systems.$inferInsert;
// Development-only table for mapping production Clerk IDs to development Clerk IDs
// This ensures production user IDs never leak into development databases
// WARNING: This table should ONLY exist in development databases
export const clerkIdMapping = sqliteTable("clerk_id_mapping", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(), // Username or email for identification
  prodClerkId: text("prod_clerk_id").notNull().unique(),
  devClerkId: text("dev_clerk_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Sync status table - tracks last synced timestamps for automatic sync
// WARNING: This table should ONLY exist in development databases
export const syncStatus = sqliteTable("sync_status", {
  tableName: text("table_name").primaryKey(), // e.g., 'readings', 'readings_agg_5m', 'point_readings'
  lastEntryMs: integer("last_entry_ms"), // Unix timestamp in milliseconds (for time-based tables)
  lastEntryDate: text("last_entry_date"), // Calendar date YYYY-MM-DD (for date-based tables like daily agg)
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`), // Last update time (ms)
});

export type PollingStatus = typeof pollingStatus.$inferSelect;
export type UserSystem = typeof userSystems.$inferSelect;
export type NewUserSystem = typeof userSystems.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ClerkIdMapping = typeof clerkIdMapping.$inferSelect;
