import { db } from './db';
import { readingsAgg5m, readings } from './db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';

/**
 * Updates the 5-minute aggregated data for a specific interval
 * Called after inserting a new reading
 */
export async function updateAggregatedData(
  systemId: number,
  readingTime: Date
): Promise<void> {
  try {
    // Calculate the 5-minute interval end time
    const intervalMs = 5 * 60 * 1000;
    const intervalEnd = new Date(Math.ceil(readingTime.getTime() / intervalMs) * intervalMs);
    const intervalStart = new Date(intervalEnd.getTime() - intervalMs);
    
    // Fetch all readings in this 5-minute interval
    const intervalReadings = await db
      .select()
      .from(readings)
      .where(
        and(
          eq(readings.systemId, systemId),
          gte(readings.inverterTime, intervalStart),
          lte(readings.inverterTime, intervalEnd)
        )
      )
      .orderBy(readings.inverterTime);
    
    if (intervalReadings.length === 0) {
      return; // No readings to aggregate
    }
    
    // Get the last reading (for state values)
    const lastReading = intervalReadings[intervalReadings.length - 1];
    
    // Calculate aggregated values
    const solarWValues = intervalReadings.map(r => r.solarW).filter(v => v !== null);
    const loadWValues = intervalReadings.map(r => r.loadW).filter(v => v !== null);
    const batteryWValues = intervalReadings.map(r => r.batteryW).filter(v => v !== null);
    const gridWValues = intervalReadings.map(r => r.gridW).filter(v => v !== null);
    
    const aggregatedData = {
      systemId,
      intervalEnd,
      
      // Power averages, min, max
      solarWAvg: solarWValues.length > 0 ? solarWValues.reduce((a, b) => a + b, 0) / solarWValues.length : null,
      solarWMin: solarWValues.length > 0 ? Math.min(...solarWValues) : null,
      solarWMax: solarWValues.length > 0 ? Math.max(...solarWValues) : null,
      
      loadWAvg: loadWValues.length > 0 ? loadWValues.reduce((a, b) => a + b, 0) / loadWValues.length : null,
      loadWMin: loadWValues.length > 0 ? Math.min(...loadWValues) : null,
      loadWMax: loadWValues.length > 0 ? Math.max(...loadWValues) : null,
      
      batteryWAvg: batteryWValues.length > 0 ? batteryWValues.reduce((a, b) => a + b, 0) / batteryWValues.length : null,
      batteryWMin: batteryWValues.length > 0 ? Math.min(...batteryWValues) : null,
      batteryWMax: batteryWValues.length > 0 ? Math.max(...batteryWValues) : null,
      
      gridWAvg: gridWValues.length > 0 ? gridWValues.reduce((a, b) => a + b, 0) / gridWValues.length : null,
      gridWMin: gridWValues.length > 0 ? Math.min(...gridWValues) : null,
      gridWMax: gridWValues.length > 0 ? Math.max(...gridWValues) : null,
      
      // State values - use last reading
      batterySOCLast: lastReading.batterySOC,
      
      // Energy counters - use last reading
      solarKwhTotalLast: lastReading.solarKwhTotal,
      loadKwhTotalLast: lastReading.loadKwhTotal,
      batteryInKwhTotalLast: lastReading.batteryInKwhTotal,
      batteryOutKwhTotalLast: lastReading.batteryOutKwhTotal,
      gridInKwhTotalLast: lastReading.gridInKwhTotal,
      gridOutKwhTotalLast: lastReading.gridOutKwhTotal,
      
      sampleCount: intervalReadings.length,
    };
    
    // Upsert the aggregated data
    await db.insert(readingsAgg5m)
      .values(aggregatedData)
      .onConflictDoUpdate({
        target: [readingsAgg5m.systemId, readingsAgg5m.intervalEnd],
        set: aggregatedData,
      });
    
    console.log(`[Aggregation] Updated 5m aggregate for interval ending ${intervalEnd.toISOString()}`);
  } catch (error) {
    console.error('[Aggregation] Error updating aggregated data:', error);
    // Don't throw - we don't want aggregation failures to break the main polling
  }
}