import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Systems table - stores inverter system information
export const systems = sqliteTable('systems', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerClerkUserId: text('owner_clerk_user_id'), // Clerk user ID of the owner who holds the vendor credentials
  vendorType: text('vendor_type').notNull(), // Vendor type (e.g., 'select.live', 'fronius', 'sma')
  vendorSiteId: text('vendor_site_id').notNull(), // Vendor's site/system identifier
  status: text('status').notNull().default('active'), // 'active', 'disabled', or 'removed'
  displayName: text('display_name').notNull(),
  model: text('model'),
  serial: text('serial'),
  ratings: text('ratings'),
  solarSize: text('solar_size'),
  batterySize: text('battery_size'),
  location: text('location', { mode: 'json' }),  // JSON object for address, city/state/country, or lat/lon
  timezoneOffsetMin: integer('timezone_offset_min').notNull().default(600), // Standard timezone offset in minutes (e.g., 600 for AEST/UTC+10, DST calculated separately)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  vendorSiteUnique: uniqueIndex('vendor_site_unique').on(table.vendorType, table.vendorSiteId),
  ownerClerkUserIdx: index('owner_clerk_user_idx').on(table.ownerClerkUserId),
  statusIdx: index('systems_status_idx').on(table.status),
}));

// Readings table - stores time-series inverter data
export const readings = sqliteTable('readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  
  // Timestamp management
  inverterTime: integer('inverter_time', { mode: 'timestamp' }).notNull(), // When inverter recorded the data
  receivedTime: integer('received_time', { mode: 'timestamp' }).notNull(), // When we fetched the data
  delaySeconds: integer('delay_seconds'), // receivedTime - inverterTime (for monitoring API lag)
  
  // Power readings (Watts, stored as integers)
  solarW: integer('solar_w').notNull(), // Calculated: solarinverter_w + shunt_w
  solarInverterW: integer('solar_inverter_w').notNull(), // Remote solar (solarinverter_w)
  shuntW: integer('shunt_w').notNull(), // Local solar (shunt_w)
  loadW: integer('load_w').notNull(),
  batteryW: integer('battery_w').notNull(),
  gridW: integer('grid_w').notNull(),
  
  // Battery data
  batterySOC: real('battery_soc').notNull(),
  
  // System status
  faultCode: integer('fault_code').notNull(),
  faultTimestamp: integer('fault_timestamp').notNull(), // Unix timestamp of fault
  generatorStatus: integer('generator_status').notNull(),
  
  // Energy counters (kWh) - lifetime totals only
  solarKwhTotal: real('solar_kwh_total'),
  loadKwhTotal: real('load_kwh_total'),
  batteryInKwhTotal: real('battery_in_kwh_total'),
  batteryOutKwhTotal: real('battery_out_kwh_total'),
  gridInKwhTotal: real('grid_in_kwh_total'),
  gridOutKwhTotal: real('grid_out_kwh_total'),
  
  // Database metadata
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // Unique constraint to prevent duplicate readings for the same system at the same time
  systemInverterTimeUnique: uniqueIndex('readings_system_inverter_time_unique').on(table.systemId, table.inverterTime),
  // Regular indexes for query performance
  systemInverterTimeIdx: index('system_inverter_time_idx').on(table.systemId, table.inverterTime),
  inverterTimeIdx: index('inverter_time_idx').on(table.inverterTime),
  receivedTimeIdx: index('received_time_idx').on(table.receivedTime),
}));


// API polling status table - track health and errors
export const pollingStatus = sqliteTable('polling_status', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  lastPollTime: integer('last_poll_time', { mode: 'timestamp' }),
  lastSuccessTime: integer('last_success_time', { mode: 'timestamp' }),
  lastErrorTime: integer('last_error_time', { mode: 'timestamp' }),
  lastError: text('last_error'),
  lastResponse: text('last_response', { mode: 'json' }), // Store full Select.Live response
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  totalPolls: integer('total_polls').notNull().default(0),
  successfulPolls: integer('successful_polls').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  systemIdx: index('polling_system_idx').on(table.systemId),
  systemIdUnique: uniqueIndex('polling_status_system_id_unique').on(table.systemId),
}));

// 5-minute aggregated readings for fast queries (up to 30 days)
export const readingsAgg5m = sqliteTable('readings_agg_5m', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull(),
  
  // Interval information
  intervalEnd: integer('interval_end').notNull(), // End of 5-minute interval (Unix timestamp in seconds)
  
  // Aggregated power values (averaged over 5 minutes) - stored as integers
  solarWAvg: integer('solar_w_avg'),
  solarWMin: integer('solar_w_min'),
  solarWMax: integer('solar_w_max'),
  solarIntervalWh: integer('solar_interval_wh'), // Energy produced in this interval (Wh)
  
  loadWAvg: integer('load_w_avg'),
  loadWMin: integer('load_w_min'),
  loadWMax: integer('load_w_max'),
  
  batteryWAvg: integer('battery_w_avg'),
  batteryWMin: integer('battery_w_min'),
  batteryWMax: integer('battery_w_max'),
  
  gridWAvg: integer('grid_w_avg'),
  gridWMin: integer('grid_w_min'),
  gridWMax: integer('grid_w_max'),
  
  // State values (last value in interval)
  batterySOCLast: real('battery_soc_last'),
  
  // Energy counters (kWh) - last value in interval
  solarKwhTotalLast: real('solar_kwh_total_last'),
  loadKwhTotalLast: real('load_kwh_total_last'),
  batteryInKwhTotalLast: real('battery_in_kwh_total_last'),
  batteryOutKwhTotalLast: real('battery_out_kwh_total_last'),
  gridInKwhTotalLast: real('grid_in_kwh_total_last'),
  gridOutKwhTotalLast: real('grid_out_kwh_total_last'),
  
  // Metadata
  sampleCount: integer('sample_count').notNull(), // Number of readings in this 5-minute interval
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  
}, (table) => ({
  // Unique constraint to prevent duplicates
  systemIntervalIdx: uniqueIndex('readings_agg_5m_system_interval_idx')
    .on(table.systemId, table.intervalEnd),
  
  // Query performance indexes
  systemIdIdx: index('readings_agg_5m_system_id_idx').on(table.systemId),
  intervalEndIdx: index('readings_agg_5m_interval_end_idx').on(table.intervalEnd),
}));

// Daily aggregated readings for long-term queries (unlimited retention)
export const readingsAgg1d = sqliteTable('readings_agg_1d', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: text('system_id').notNull(),
  day: text('day').notNull(), // YYYY-MM-DD format (system local time)
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`), // Unix epoch seconds
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`), // Unix epoch seconds
  
  // Energy metrics (kWh)
  solarKwh: real('solar_kwh'),
  loadKwh: real('load_kwh'),
  batteryChargeKwh: real('battery_charge_kwh'),
  batteryDischargeKwh: real('battery_discharge_kwh'),
  gridImportKwh: real('grid_import_kwh'),
  gridExportKwh: real('grid_export_kwh'),
  
  // Power statistics (W) - stored as integers
  solarWMin: integer('solar_w_min'),
  solarWAvg: integer('solar_w_avg'),
  solarWMax: integer('solar_w_max'),
  loadWMin: integer('load_w_min'),
  loadWAvg: integer('load_w_avg'),
  loadWMax: integer('load_w_max'),
  batteryWMin: integer('battery_w_min'),
  batteryWAvg: integer('battery_w_avg'),
  batteryWMax: integer('battery_w_max'),
  gridWMin: integer('grid_w_min'),
  gridWAvg: integer('grid_w_avg'),
  gridWMax: integer('grid_w_max'),
  
  // Battery SOC statistics (%)
  batterySocMax: real('battery_soc_max'),
  batterySocMin: real('battery_soc_min'),
  batterySocAvg: real('battery_soc_avg'),
  batterySocEnd: real('battery_soc_end'),
  
  // All-time Energy metrics (kWh) - values at end of day
  solarAlltimeKwh: real('solar_alltime_kwh'),
  loadAlltimeKwh: real('load_alltime_kwh'),
  batteryChargeAlltimeKwh: real('battery_charge_alltime_kwh'),
  batteryDischargeAlltimeKwh: real('battery_discharge_alltime_kwh'),
  gridImportAlltimeKwh: real('grid_import_alltime_kwh'),
  gridExportAlltimeKwh: real('grid_export_alltime_kwh'),
  
  // Data quality
  intervalCount: integer('interval_count').notNull().default(0), // Number of non-null 5 min intervals aggregated
  sampleCount: integer('sample_count').notNull().default(0), // Total number of raw samples (cascaded from 5-min intervals)
  
  // Metadata
  version: integer('version').default(1),
}, (table) => ({
  // Unique constraint on system and day
  systemDayIdx: uniqueIndex('idx_readings_agg_1d_system_day')
    .on(table.systemId, table.day),
  
  // For filtering by day ranges
  dayIdx: index('idx_readings_agg_1d_day').on(table.day),
  
  // For finding records that need updating
  updatedIdx: index('idx_readings_agg_1d_updated').on(table.updatedAt),
}));

// User-System junction table for many-to-many relationship
export const userSystems = sqliteTable('user_systems', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clerkUserId: text('clerk_user_id').notNull(),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('viewer'), // 'owner', 'admin', 'viewer'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  userSystemUnique: uniqueIndex('user_system_unique').on(table.clerkUserId, table.systemId),
  userIdx: index('user_systems_user_idx').on(table.clerkUserId),
  systemIdx: index('user_systems_system_idx').on(table.systemId),
}));

// Type exports for TypeScript
export type System = typeof systems.$inferSelect;
export type NewSystem = typeof systems.$inferInsert;
// Development-only table for mapping production Clerk IDs to development Clerk IDs
// This ensures production user IDs never leak into development databases
// WARNING: This table should ONLY exist in development databases
export const clerkIdMapping = sqliteTable('clerk_id_mapping', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull(), // Username or email for identification
  prodClerkId: text('prod_clerk_id').notNull().unique(),
  devClerkId: text('dev_clerk_id').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Reading = typeof readings.$inferSelect;
export type NewReading = typeof readings.$inferInsert;
export type PollingStatus = typeof pollingStatus.$inferSelect;
export type UserSystem = typeof userSystems.$inferSelect;
export type NewUserSystem = typeof userSystems.$inferInsert;
export type ClerkIdMapping = typeof clerkIdMapping.$inferSelect;