import { sqliteTable, integer, real, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// 5-minute aggregated readings for fast queries (up to 30 days)
export const readingsAgg5m = sqliteTable('readings_agg_5m', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  systemId: integer('system_id').notNull(),
  
  // Interval information
  intervalEnd: integer('interval_end', { mode: 'timestamp' }).notNull(), // End of 5-minute interval
  
  // Aggregated power values (averaged over 5 minutes)
  solarWAvg: real('solar_w_avg'),
  solarWMin: real('solar_w_min'),
  solarWMax: real('solar_w_max'),
  
  loadWAvg: real('load_w_avg'),
  loadWMin: real('load_w_min'),
  loadWMax: real('load_w_max'),
  
  batteryWAvg: real('battery_w_avg'),
  batteryWMin: real('battery_w_min'),
  batteryWMax: real('battery_w_max'),
  
  gridWAvg: real('grid_w_avg'),
  gridWMin: real('grid_w_min'),
  gridWMax: real('grid_w_max'),
  
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