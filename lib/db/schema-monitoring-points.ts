import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { systems } from "./schema";

// Point Info table - stores individual monitoring points
export const pointInfo = sqliteTable(
  "point_info",
  {
    // Composite primary key (systemId, index)
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    index: integer("id").notNull(), // Sequential per system, not auto-increment (database column "id", TS property "index")

    // Identification (original IDs from vendor system)
    originId: text("origin_id").notNull(), // eg. "5ecacac2-3cc3-447a-b3b5-423e333031e6"
    originSubId: text("origin_sub_id"), // eg. "energyNowW"

    // default display name
    defaultName: text("point_name").notNull(), // from device eg. "Battery"

    // user modifiable
    subsystem: text("subsystem"), // eg. nullable, "solar", "battery", "location", "meter" - set at init, not editable
    type: text("type"), // eg. "source", "load", "bidi" - user settable dropdown
    subtype: text("subtype"), // eg. "pool", "ev", "solar1" - user settable free text
    extension: text("extension"), // eg. additional qualifier - user settable free text
    displayName: text("display_name").notNull(), // user settable, will generally be the same as pointName
    alias: text("short_name"), // Optional short name (letters, digits, underscore only) - used in history API IDs

    // Type and unit
    metricType: text("metric_type").notNull(), // eg. 'power', 'energy', 'soc'
    metricUnit: text("metric_unit").notNull(), // eg. 'W', 'Wh', '%'

    // Flags
    active: integer("active", { mode: "boolean" }).notNull().default(true), // Whether this point is active (enabled)
    transform: text("transform"), // Optional transform: null = no transform, 'i' = invert, 'd' = differentiate

    // Timestamps
    created: integer("created"), // Creation timestamp (Unix milliseconds)
    updatedAt: integer("updated_at").default(sql`(unixepoch() * 1000)`), // Last update timestamp (Unix milliseconds)
  },
  (table) => ({
    pk: primaryKey({ columns: [table.systemId, table.index] }),
    // Unique constraint on origin point (system + origin_id + origin_sub_id)
    systemPointUnique: uniqueIndex("pi_system_point_unique").on(
      table.systemId,
      table.originId,
      table.originSubId,
    ),
    systemIdx: index("pi_system_idx").on(table.systemId),
    subsystemIdx: index("pi_subsystem_idx").on(table.subsystem),
    metricTypeIdx: index("pi_metric_type_idx").on(table.metricType),
    // Unique constraint for short_name within a system (only when short_name is not null)
    systemShortNameUnique: uniqueIndex("pi_system_short_name_unique").on(
      table.systemId,
      table.alias,
    ),
  }),
);

// Point Readings table - stores time-series data
export const pointReadings = sqliteTable(
  "point_readings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Relationships
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pointId: integer("point_id").notNull(),
    // Composite foreign key to point_info(system_id, id)
    sessionId: integer("session_id"), // No longer references measurementSessions

    // Timestamps (milliseconds for sub-second precision)
    measurementTime: integer("measurement_time").notNull(), // When device recorded
    receivedTime: integer("received_time").notNull(), // When we fetched

    // Core measurements (flexible schema)
    value: real("value"), // Numeric value (e.g., power in Watts, timestamp in ms)
    valueStr: text("value_str"), // String value (e.g., fault codes, text data)

    // Quality & status
    error: text("error"), // Error message if any
    dataQuality: text("data_quality").notNull().default("good"), // 'good', 'error', 'estimated', 'interpolated'
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
    // Composite foreign key to point_info
    pointInfoFk: foreignKey({
      columns: [table.systemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
    }).onDelete("cascade"),
  }),
);

// 5-minute aggregation table
export const pointReadingsAgg5m = sqliteTable(
  "point_readings_agg_5m",
  {
    // Relationships
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pointId: integer("point_id").notNull(),
    // Composite foreign key to point_info(system_id, id)
    sessionId: integer("session_id"), // Optional session ID for tracking data source
    intervalEnd: integer("interval_end").notNull(), // End of interval (ms)

    // Aggregates (generic - units determined by point_info.metricUnit)
    // These can be null if all readings in the interval were errors
    avg: real("avg"),
    min: real("min"),
    max: real("max"),
    last: real("last"),
    delta: real("delta"), // For differentiated values (points with transform='d')
    valueStr: text("value_str"), // For text values (e.g., tariff periods, fault codes)

    // Sampling metadata
    sampleCount: integer("sample_count").notNull(),
    errorCount: integer("error_count").notNull(),
    dataQuality: text("data_quality"), // 'good', 'forecast', 'actual', 'billable', etc.
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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
    // Composite foreign key to point_info
    pointInfoFk: foreignKey({
      columns: [table.systemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
    }).onDelete("cascade"),
  }),
);

// Daily aggregation table
export const pointReadingsAgg1d = sqliteTable(
  "point_readings_agg_1d",
  {
    // Relationships
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pointId: integer("point_id").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD format (system local timezone)

    // Aggregates (generic - units determined by point_info.metricUnit)
    // These can be null if all readings in the interval were errors
    avg: real("avg"), // Average of 5-min averages
    min: real("min"), // Minimum of 5-min minimums
    max: real("max"), // Maximum of 5-min maximums
    last: real("last"), // Value from 00:00 interval (last interval of previous day)
    delta: real("delta"), // Sum of 5-min deltas (for differentiated points)

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
    pk: primaryKey({
      columns: [table.systemId, table.pointId, table.day],
    }),
    systemDayIdx: index("pr1d_system_day_idx").on(table.systemId, table.day),
    dayIdx: index("pr1d_day_idx").on(table.day),
    // Composite foreign key to point_info
    pointInfoFk: foreignKey({
      columns: [table.systemId, table.pointId],
      foreignColumns: [pointInfo.systemId, pointInfo.index],
    }).onDelete("cascade"),
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
    references: [
      (pointReadings as any).systemId,
      (pointReadings as any).pointId,
    ],
  },
  aggregates5m: {
    relation: "one-to-many",
    to: pointReadingsAgg5m,
    references: [
      (pointReadingsAgg5m as any).systemId,
      (pointReadingsAgg5m as any).pointId,
    ],
  },
  aggregates1d: {
    relation: "one-to-many",
    to: pointReadingsAgg1d,
    references: [
      (pointReadingsAgg1d as any).systemId,
      (pointReadingsAgg1d as any).pointId,
    ],
  },
};

export const pointReadingsRelations = {
  point: {
    relation: "many-to-one",
    to: pointInfo,
    references: [(pointInfo as any).systemId, (pointInfo as any).id],
  },
};

export const pointReadingsAgg5mRelations = {
  point: {
    relation: "many-to-one",
    to: pointInfo,
    references: [(pointInfo as any).systemId, (pointInfo as any).id],
  },
};

export const pointReadingsAgg1dRelations = {
  point: {
    relation: "many-to-one",
    to: pointInfo,
    references: [(pointInfo as any).systemId, (pointInfo as any).id],
  },
};
