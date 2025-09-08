import { db } from '@/lib/db';
import { readings, pollingStatus } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { LatestReadingData } from '@/lib/types/readings';
import { roundToThree } from '@/lib/format-opennem';

/**
 * Get the last reading for a Selectronic system
 * Returns data from the readings table in API format
 */
export async function getLastReading(systemId: number): Promise<LatestReadingData | null> {
  const [latestReading] = await db.select()
    .from(readings)
    .where(eq(readings.systemId, systemId))
    .orderBy(desc(readings.inverterTime))
    .limit(1);
  
  if (!latestReading) {
    return null;
  }
  
  // Get today's energy from polling status
  const [status] = await db.select()
    .from(pollingStatus)
    .where(eq(pollingStatus.systemId, systemId))
    .limit(1);
  
  const lastResponse = status?.lastResponse as any;
  
  return {
    timestamp: latestReading.inverterTime,
    receivedTime: latestReading.receivedTime,
    power: {
      solarW: latestReading.solarW,
      solarInverterW: latestReading.solarInverterW,
      shuntW: latestReading.shuntW,
      loadW: latestReading.loadW,
      batteryW: latestReading.batteryW,
      gridW: latestReading.gridW,
    },
    soc: {
      battery: latestReading.batterySOC,
    },
    energy: {
      today: {
        solarKwh: roundToThree(lastResponse?.solarKwhToday),
        loadKwh: roundToThree(lastResponse?.loadKwhToday),
        batteryInKwh: roundToThree(lastResponse?.batteryInKwhToday),
        batteryOutKwh: roundToThree(lastResponse?.batteryOutKwhToday),
        gridInKwh: roundToThree(lastResponse?.gridInKwhToday),
        gridOutKwh: roundToThree(lastResponse?.gridOutKwhToday),
      },
    },
    system: {
      faultCode: latestReading.faultCode,
      faultTimestamp: latestReading.faultTimestamp,
      generatorStatus: latestReading.generatorStatus,
    },
  };
}