import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Systems table - stores inverter system information
export const systems = sqliteTable('systems', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  systemNumber: text('system_number').notNull(),
  displayName: text('display_name'),
  model: text('model'),
  serial: text('serial'),
  ratings: text('ratings'),
  solarSize: text('solar_size'),
  batterySize: text('battery_size'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userSystemIdx: index('user_system_idx').on(table.userId, table.systemNumber),
}));

// Readings table - stores time-series inverter data
export const readings = sqliteTable('readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  
  // Timestamp management
  inverterTime: integer('inverter_time', { mode: 'timestamp' }).notNull(), // When inverter recorded the data
  receivedTime: integer('received_time', { mode: 'timestamp' }).notNull(), // When we fetched the data
  delaySeconds: integer('delay_seconds'), // receivedTime - inverterTime (for monitoring API lag)
  
  // Power readings (Watts)
  solarPower: real('solar_power').notNull(), // Calculated: solarinverter_w + shunt_w
  solarInverterPower: real('solar_inverter_power').notNull(), // Remote solar (solarinverter_w)
  shuntPower: real('shunt_power').notNull(), // Local solar (shunt_w)
  loadPower: real('load_power').notNull(),
  batteryPower: real('battery_power').notNull(),
  gridPower: real('grid_power').notNull(),
  
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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  systemInverterTimeIdx: index('system_inverter_time_idx').on(table.systemId, table.inverterTime),
  inverterTimeIdx: index('inverter_time_idx').on(table.inverterTime),
  receivedTimeIdx: index('received_time_idx').on(table.receivedTime),
}));

// Hourly aggregates for efficient querying
export const hourlyAggregates = sqliteTable('hourly_aggregates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  hourStart: integer('hour_start', { mode: 'timestamp' }).notNull(), // Start of hour
  
  // Average power readings
  avgSolarPower: real('avg_solar_power').notNull(),
  avgLoadPower: real('avg_load_power').notNull(),
  avgBatteryPower: real('avg_battery_power').notNull(),
  avgGridPower: real('avg_grid_power').notNull(),
  
  // Peak power readings
  maxSolarPower: real('max_solar_power').notNull(),
  maxLoadPower: real('max_load_power').notNull(),
  maxBatteryCharge: real('max_battery_charge').notNull(),
  maxBatteryDischarge: real('max_battery_discharge').notNull(),
  maxGridImport: real('max_grid_import').notNull(),
  maxGridExport: real('max_grid_export').notNull(),
  
  // Battery SOC
  minBatterySOC: real('min_battery_soc').notNull(),
  maxBatterySOC: real('max_battery_soc').notNull(),
  avgBatterySOC: real('avg_battery_soc').notNull(),
  
  // Energy totals for the hour (Wh)
  solarEnergy: real('solar_energy').notNull(),
  loadEnergy: real('load_energy').notNull(),
  batteryChargeEnergy: real('battery_charge_energy').notNull(),
  batteryDischargeEnergy: real('battery_discharge_energy').notNull(),
  gridImportEnergy: real('grid_import_energy').notNull(),
  gridExportEnergy: real('grid_export_energy').notNull(),
  
  // Data quality metrics
  readingCount: integer('reading_count').notNull(),
  avgDelaySeconds: real('avg_delay_seconds'), // Average API delay for this hour
  maxDelaySeconds: integer('max_delay_seconds'), // Max API delay for this hour
  
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  systemHourIdx: index('system_hour_idx').on(table.systemId, table.hourStart),
}));

// Daily aggregates for long-term storage
export const dailyAggregates = sqliteTable('daily_aggregates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  date: integer('date', { mode: 'timestamp' }).notNull(), // Start of day (00:00:00)
  
  // Energy totals for the day (kWh)
  solarEnergy: real('solar_energy').notNull(),
  loadEnergy: real('load_energy').notNull(),
  batteryChargeEnergy: real('battery_charge_energy').notNull(),
  batteryDischargeEnergy: real('battery_discharge_energy').notNull(),
  gridImportEnergy: real('grid_import_energy').notNull(),
  gridExportEnergy: real('grid_export_energy').notNull(),
  
  // Peak values
  peakSolarPower: real('peak_solar_power').notNull(),
  peakLoadPower: real('peak_load_power').notNull(),
  peakSolarTime: integer('peak_solar_time', { mode: 'timestamp' }), // When peak solar occurred
  
  // Battery SOC range
  minBatterySOC: real('min_battery_soc').notNull(),
  maxBatterySOC: real('max_battery_soc').notNull(),
  
  // Self-sufficiency metrics
  selfSufficiencyPercent: real('self_sufficiency_percent'),
  solarUtilizationPercent: real('solar_utilization_percent'),
  
  // Data quality
  totalReadings: integer('total_readings').notNull(),
  avgDelaySeconds: real('avg_delay_seconds'),
  
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  systemDateIdx: index('system_date_idx').on(table.systemId, table.date),
}));

// API polling status table - track health and errors
export const pollingStatus = sqliteTable('polling_status', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull().references(() => systems.id, { onDelete: 'cascade' }),
  lastPollTime: integer('last_poll_time', { mode: 'timestamp' }),
  lastSuccessTime: integer('last_success_time', { mode: 'timestamp' }),
  lastErrorTime: integer('last_error_time', { mode: 'timestamp' }),
  lastError: text('last_error'),
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  totalPolls: integer('total_polls').notNull().default(0),
  successfulPolls: integer('successful_polls').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  systemIdx: index('polling_system_idx').on(table.systemId),
}));

// Type exports for TypeScript
export type System = typeof systems.$inferSelect;
export type NewSystem = typeof systems.$inferInsert;
export type Reading = typeof readings.$inferSelect;
export type NewReading = typeof readings.$inferInsert;
export type HourlyAggregate = typeof hourlyAggregates.$inferSelect;
export type DailyAggregate = typeof dailyAggregates.$inferSelect;
export type PollingStatus = typeof pollingStatus.$inferSelect;