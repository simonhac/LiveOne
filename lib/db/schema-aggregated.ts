import { sqliteTable, integer, real, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 5-minute aggregated readings for fast queries (up to 30 days)
export const readingsAgg5m = sqliteTable('readings_agg_5m', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull(),
  
  // Interval information
  intervalEnd: integer('interval_end', { mode: 'timestamp' }).notNull(), // End of 5-minute interval
  
  // Aggregated power values (averaged over 5 minutes) - stored as integers
  solarWAvg: integer('solar_w_avg'),
  solarWMin: integer('solar_w_min'),
  solarWMax: integer('solar_w_max'),
  
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
  intervalCount: integer('interval_count'), // Number of non-null 5 min intervals aggregated
  
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