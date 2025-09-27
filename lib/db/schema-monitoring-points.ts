import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { systems } from './schema';

// Note: pointGroups table has been removed - now using systems table directly

// Point Sub-Groups table - stores monitoring point groups/subcircuits
export const pointSubGroups: any = sqliteTable('point_sub_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Relationships
  groupId: integer('group_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  parentSubGroupId: integer('parent_sub_group_id'),

  // Identification
  vendorId: text('vendor_id').notNull(), // Vendor's subcircuit/group ID
  name: text('name').notNull(),
  displayName: text('display_name'),
  description: text('description'),

  // Type information
  groupType: text('group_type'), // 'location', 'subcircuit', 'device_group', etc.

  // Configuration
  pollingEnabled: integer('polling_enabled', { mode: 'boolean' }).notNull().default(true),

  // Metadata
  vendorMetadata: text('vendor_metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => ({
  groupSubGroupUnique: uniqueIndex('psg_group_vendor_unique').on(table.groupId, table.vendorId),
  groupIdx: index('psg_group_idx').on(table.groupId),
  parentIdx: index('psg_parent_idx').on(table.parentSubGroupId),
  pollingIdx: index('psg_polling_idx').on(table.pollingEnabled),
}));

// Point Info table - stores individual monitoring points
export const pointInfo = sqliteTable('point_info', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Relationships
  groupId: integer('group_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  subGroupId: integer('sub_group_id').references(() => pointSubGroups.id, { onDelete: 'set null' }),

  // Identification
  vendorId: text('vendor_id').notNull(), // Vendor's point ID
  name: text('name').notNull(),
  displayName: text('display_name'),
  description: text('description'),

  // Type and metrics
  pointType: text('point_type').notNull(), // 'solar', 'battery', 'grid', 'load', 'hvac', etc.
  deviceType: text('device_type'), // 'PvInverter', 'HybridPv', 'HeatPump', etc.
  measurementTypes: text('measurement_types', { mode: 'json' }).notNull(), // ['power', 'energy', 'soc', 'temperature']
  units: text('units', { mode: 'json' }), // {'power': 'W', 'energy': 'Wh', 'soc': '%'}

  // Status
  status: text('status').notNull().default('active'), // 'active', 'disabled', 'removed'
  lastSeenAt: integer('last_seen_at'), // Milliseconds

  // Configuration
  pollingEnabled: integer('polling_enabled', { mode: 'boolean' }).notNull().default(true),
  aggregationEnabled: integer('aggregation_enabled', { mode: 'boolean' }).notNull().default(true),

  // Metadata
  vendorMetadata: text('vendor_metadata', { mode: 'json' }),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => ({
  groupVendorUnique: uniqueIndex('pi_group_vendor_unique').on(table.groupId, table.vendorId),
  groupIdx: index('pi_group_idx').on(table.groupId),
  subGroupIdx: index('pi_sub_group_idx').on(table.subGroupId),
  typeIdx: index('pi_type_idx').on(table.pointType),
  statusIdx: index('pi_status_idx').on(table.status),
  pollingIdx: index('pi_polling_idx').on(table.pollingEnabled),
}));

// Measurement Sessions table - tracks API fetch sessions
export const measurementSessions = sqliteTable('measurement_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Session identification
  groupId: integer('group_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  sessionType: text('session_type').notNull(), // 'scheduled', 'manual', 'catchup'

  // Timing
  startedAt: integer('started_at').notNull().default(sql`(unixepoch() * 1000)`),
  completedAt: integer('completed_at'),

  // Results
  pointsQueried: integer('points_queried').notNull().default(0),
  pointsSuccess: integer('points_success').notNull().default(0),
  pointsFailed: integer('points_failed').notNull().default(0),

  // Performance metrics
  apiCallCount: integer('api_call_count').notNull().default(0),
  totalDurationMs: integer('total_duration_ms'),

  // Error tracking
  errorMessages: text('error_messages', { mode: 'json' }), // Array of error messages

  // Metadata
  vendorResponseMetadata: text('vendor_response_metadata', { mode: 'json' }),
}, (table) => ({
  groupIdx: index('ms_group_idx').on(table.groupId),
  startedAtIdx: index('ms_started_at_idx').on(table.startedAt),
  sessionTypeIdx: index('ms_session_type_idx').on(table.sessionType),
}));

// Point Readings table - stores time-series data
export const pointReadings = sqliteTable('point_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  // Relationships
  pointId: integer('point_id').notNull().references(() => pointInfo.id, { onDelete: 'cascade' }),
  sessionId: integer('session_id').references(() => measurementSessions.id, { onDelete: 'set null' }),

  // Timestamps (milliseconds for sub-second precision)
  measurementTime: integer('measurement_time').notNull(), // When device recorded
  receivedTime: integer('received_time').notNull(), // When we fetched
  delayMs: integer('delay_ms'), // receivedTime - measurementTime

  // Core measurements (flexible schema)
  powerW: real('power_w'), // Current power in Watts
  energyWh: real('energy_wh'), // Cumulative energy in Watt-hours
  energyTodayWh: real('energy_today_wh'), // Today's energy
  energyYesterdayWh: real('energy_yesterday_wh'), // Yesterday's energy

  // Battery-specific
  batterySOC: real('battery_soc'), // State of charge percentage
  batteryVoltage: real('battery_voltage'), // Voltage
  batteryCurrent: real('battery_current'), // Current
  batteryTemperature: real('battery_temperature'), // Temperature

  // Additional metrics (JSON for flexibility)
  additionalMetrics: text('additional_metrics', { mode: 'json' }), // Any other vendor-specific metrics

  // Quality & status
  deviceStatus: text('device_status'), // 'online', 'offline', 'fault'
  dataQuality: text('data_quality'), // 'good', 'estimated', 'interpolated'

  // Raw data preservation
  rawData: text('raw_data', { mode: 'json' }), // Original vendor response
}, (table) => ({
  pointTimeUnique: uniqueIndex('pr_point_time_unique').on(table.pointId, table.measurementTime),
  pointIdx: index('pr_point_idx').on(table.pointId),
  timeIdx: index('pr_time_idx').on(table.measurementTime),
  sessionIdx: index('pr_session_idx').on(table.sessionId),
}));

// 5-minute aggregation table
export const pointReadingsAgg5m = sqliteTable('point_readings_agg_5m', {
  // Composite primary key
  pointId: integer('point_id').notNull().references(() => pointInfo.id, { onDelete: 'cascade' }),
  intervalStart: integer('interval_start').notNull(), // Start of 5-min interval (ms)

  // Interval metadata
  intervalEnd: integer('interval_end').notNull(), // End of interval (ms)
  sampleCount: integer('sample_count').notNull(), // Number of samples in interval

  // Power aggregates (Watts)
  powerAvg: real('power_avg'),
  powerMin: real('power_min'),
  powerMax: real('power_max'),
  powerStdDev: real('power_std_dev'),

  // Energy aggregates (Wh)
  energyDelta: real('energy_delta'), // Energy change in this interval
  energyEnd: real('energy_end'), // Cumulative energy at interval end

  // Battery aggregates
  batterySOCAvg: real('battery_soc_avg'),
  batterySOCMin: real('battery_soc_min'),
  batterySOCMax: real('battery_soc_max'),

  // Additional aggregated metrics
  additionalAggregates: text('additional_aggregates', { mode: 'json' }),

  // Quality metrics
  dataCompleteness: real('data_completeness'), // Percentage of expected samples
  uptimeSeconds: integer('uptime_seconds'), // Seconds device was online

  // Processing metadata
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => ({
  // Composite primary key
  pk: primaryKey({ columns: [table.pointId, table.intervalStart] }),
  // Indexes
  timeIdx: index('pr5m_time_idx').on(table.intervalStart),
  pointTimeIdx: index('pr5m_point_time_idx').on(table.pointId, table.intervalStart),
}));

// Note: pointGroupsRelations removed - relationships now through systems table

export const pointSubGroupsRelations = {
  group: {
    relation: 'many-to-one',
    to: systems,
    references: [(systems as any).id],
  },
  parent: {
    relation: 'many-to-one',
    to: pointSubGroups,
    references: [(pointSubGroups as any).id],
  },
  children: {
    relation: 'one-to-many',
    to: pointSubGroups,
    references: [(pointSubGroups as any).parentSubGroupId],
  },
  points: {
    relation: 'one-to-many',
    to: pointInfo,
    references: [(pointInfo as any).subGroupId],
  },
};

export const pointInfoRelations = {
  group: {
    relation: 'many-to-one',
    to: systems,
    references: [(systems as any).id],
  },
  subGroup: {
    relation: 'many-to-one',
    to: pointSubGroups,
    references: [(pointSubGroups as any).id],
  },
  readings: {
    relation: 'one-to-many',
    to: pointReadings,
    references: [(pointReadings as any).pointId],
  },
  aggregates5m: {
    relation: 'one-to-many',
    to: pointReadingsAgg5m,
    references: [(pointReadingsAgg5m as any).pointId],
  },
};

export const pointReadingsRelations = {
  point: {
    relation: 'many-to-one',
    to: pointInfo,
    references: [(pointInfo as any).id],
  },
  session: {
    relation: 'many-to-one',
    to: measurementSessions,
    references: [(measurementSessions as any).id],
  },
};

export const measurementSessionsRelations = {
  group: {
    relation: 'many-to-one',
    to: systems,
    references: [(systems as any).id],
  },
  readings: {
    relation: 'one-to-many',
    to: pointReadings,
    references: [(pointReadings as any).sessionId],
  },
};

export const pointReadingsAgg5mRelations = {
  point: {
    relation: 'many-to-one',
    to: pointInfo,
    references: [(pointInfo as any).id],
  },
};