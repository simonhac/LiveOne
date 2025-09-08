import { db } from '@/lib/db';
import { readingsAgg5m, systems } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { LatestReadingData } from '@/lib/types/readings';
import { getTodayEnergy } from './enphase-today-energy';

/**
 * Get the last reading for an Enphase system
 * Returns data from the readings_agg_5m table in API format
 * Note: Enphase systems don't have real-time data, only 5-minute aggregations
 */
export async function getLastReading(systemId: number): Promise<LatestReadingData | null> {
  const [latestAgg] = await db.select()
    .from(readingsAgg5m)
    .where(eq(readingsAgg5m.systemId, systemId))
    .orderBy(desc(readingsAgg5m.intervalEnd))
    .limit(1);
  
  if (!latestAgg) {
    return null;
  }
  
  // Get system timezone for today energy calculation
  const [system] = await db.select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
  
  // Get today's energy totals
  const todayEnergy = await getTodayEnergy(systemId, system.timezoneOffsetMin);
  
  // Convert aggregated data to reading format
  // intervalEnd is Unix timestamp in seconds
  const timestamp = new Date(latestAgg.intervalEnd * 1000);
  
  return {
    timestamp: timestamp,
    receivedTime: latestAgg.createdAt || timestamp,
    power: {
      solarW: latestAgg.solarWAvg,
      solarInverterW: null, // Not available for Enphase
      shuntW: null, // Not available for Enphase
      loadW: latestAgg.loadWAvg,
      batteryW: latestAgg.batteryWAvg,
      gridW: latestAgg.gridWAvg,
    },
    soc: {
      battery: latestAgg.batterySOCLast,
    },
    energy: {
      today: todayEnergy,
    },
    system: {
      faultCode: null, // Not available for Enphase
      faultTimestamp: null,
      generatorStatus: null,
    },
  };
}