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
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
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
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  totalPolls: integer('total_polls').notNull().default(0),
  successfulPolls: integer('successful_polls').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  systemIdx: index('polling_system_idx').on(table.systemId),
}));

// Import aggregated readings table
export { readingsAgg5m } from './schema-aggregated';

// Type exports for TypeScript
export type System = typeof systems.$inferSelect;
export type NewSystem = typeof systems.$inferInsert;
export type Reading = typeof readings.$inferSelect;
export type NewReading = typeof readings.$inferInsert;
export type PollingStatus = typeof pollingStatus.$inferSelect;