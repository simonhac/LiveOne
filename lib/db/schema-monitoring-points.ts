import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { systems } from "./schema";

// Point Info table - stores individual monitoring points
export const pointInfo = sqliteTable(
  "point_info",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Relationships
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),

    // Identification
    pointId: text("point_id").notNull(), // eg. "5ecacac2-3cc3-447a-b3b5-423e333031e6"
    pointSubId: text("point_sub_id"), // eg. "energyNowW"

    // default display name
    defaultName: text("point_name").notNull(), // from device eg. "Battery"

    // user modifiable
    subsystem: text("subsystem"), // eg. nullable, "solar", "battery", "location", "meter" - set at init, not editable
    type: text("type"), // eg. "source", "load", "bidi" - user settable dropdown
    subtype: text("subtype"), // eg. "pool", "ev", "solar1" - user settable free text
    extension: text("extension"), // eg. additional qualifier - user settable free text
    name: text("display_name").notNull(), // user settable, will generally be the same as pointName
    shortName: text("short_name"), // Optional short name (letters, digits, underscore only) - used in history API IDs

    // Type and unit
    metricType: text("metric_type").notNull(), // eg. 'power', 'energy', 'soc'
    metricUnit: text("metric_unit").notNull(), // eg. 'W', 'Wh', '%'
  },
  (table) => ({
    systemPointUnique: uniqueIndex("pi_system_point_unique").on(
      table.systemId,
      table.pointId,
      table.pointSubId,
    ),
    systemIdx: index("pi_system_idx").on(table.systemId),
    subsystemIdx: index("pi_subsystem_idx").on(table.subsystem),
    metricTypeIdx: index("pi_metric_type_idx").on(table.metricType),
    // Unique constraint for short_name within a system (only when short_name is not null)
    systemShortNameUnique: uniqueIndex("pi_system_short_name_unique").on(
      table.systemId,
      table.shortName,
    ),
  }),
);

// Point Readings table - stores time-series data
export const pointReadings = sqliteTable(
  "point_readings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Relationships (denormalized for query performance)
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pointId: integer("point_id")
      .notNull()
      .references(() => pointInfo.id, { onDelete: "cascade" }),
    sessionId: integer("session_id"), // No longer references measurementSessions

    // Timestamps (milliseconds for sub-second precision)
    measurementTime: integer("measurement_time").notNull(), // When device recorded
    receivedTime: integer("received_time").notNull(), // When we fetched

    // Core measurements (flexible schema)
    value: real("value"), // Current value (e.g., power in Watts)

    // Quality & status
    error: text("error"), // Error message if any
    dataQuality: text("data_quality").notNull().default("good"), // 'good', 'error', 'estimated', 'interpolated'
  },
  (table) => ({
    pointTimeUnique: uniqueIndex("pr_point_time_unique").on(
      table.pointId,
      table.measurementTime,
    ),
    systemTimeIdx: index("pr_system_time_idx").on(
      table.systemId,
      table.measurementTime,
    ),
    pointIdx: index("pr_point_idx").on(table.pointId),
    sessionIdx: index("pr_session_idx").on(table.sessionId),
  }),
);

// 5-minute aggregation table
export const pointReadingsAgg5m = sqliteTable(
  "point_readings_agg_5m",
  {
    // Relationships (denormalized for query performance)
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pointId: integer("point_id")
      .notNull()
      .references(() => pointInfo.id, { onDelete: "cascade" }),
    intervalEnd: integer("interval_end").notNull(), // End of interval (ms)

    // Aggregates (generic - units determined by point_info.metricUnit)
    // These can be null if all readings in the interval were errors
    avg: real("avg"),
    min: real("min"),
    max: real("max"),
    last: real("last"),

    // Sampling metadata
    sampleCount: integer("sample_count").notNull(),
    errorCount: integer("error_count").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pointId, table.intervalEnd] }),
    systemTimeIdx: index("pr5m_system_time_idx").on(
      table.systemId,
      table.intervalEnd,
    ),
  }),
);

// Relations for point info
export const pointInfoRelations = {
  system: {
    relation: "many-to-one",
    to: systems,
    references: [(systems as any).id],
  },
  readings: {
    relation: "one-to-many",
    to: pointReadings,
    references: [(pointReadings as any).pointId],
  },
  aggregates5m: {
    relation: "one-to-many",
    to: pointReadingsAgg5m,
    references: [(pointReadingsAgg5m as any).pointId],
  },
};

export const pointReadingsRelations = {
  point: {
    relation: "many-to-one",
    to: pointInfo,
    references: [(pointInfo as any).id],
  },
  // session relation removed - no longer using measurementSessions
};

// Note: measurementSessionsRelations removed - using the main sessions table

export const pointReadingsAgg5mRelations = {
  point: {
    relation: "many-to-one",
    to: pointInfo,
    references: [(pointInfo as any).id],
  },
};
