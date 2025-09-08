import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export interface TodayEnergyData {
  solarKwh: number | null;
  loadKwh: number | null;
  batteryInKwh: number | null;
  batteryOutKwh: number | null;
  gridInKwh: number | null;
  gridOutKwh: number | null;
}

/**
 * Calculate today's energy totals for an Enphase system
 * Sums up interval energy values from readings_agg_5m since 00:05 in the system's timezone
 * Note: Enphase data starts at 00:05, not 00:00
 */
export async function getTodayEnergy(systemId: number, timezoneOffsetMin: number): Promise<TodayEnergyData> {
  // Calculate 00:05 today in the system's timezone
  const now = new Date();
  const utcMidnight = new Date(now);
  utcMidnight.setUTCHours(0, 5, 0, 0); // Set to 00:05 UTC
  
  // Adjust for timezone to get local 00:05
  const local0005Utc = new Date(utcMidnight.getTime() - timezoneOffsetMin * 60 * 1000);
  const startTimestamp = Math.floor(local0005Utc.getTime() / 1000);

  // Query aggregated solar sum using raw SQL
  const result = await db.get<{ solarKwh: number | null; numSolarReadings: number }>(
    sql`
      SELECT 
        CAST(SUM(solar_interval_wh) AS REAL) / 1000.0 as solarKwh,
        COUNT(solar_interval_wh) as numSolarReadings
      FROM readings_agg_5m 
      WHERE system_id = ${systemId} 
        AND interval_end >= ${startTimestamp}
    `
  );

  return {
    solarKwh: result && result.numSolarReadings > 0 ? result.solarKwh : null,
    loadKwh: null,
    batteryInKwh: null,
    batteryOutKwh: null,
    gridInKwh: null,
    gridOutKwh: null,
  };
}