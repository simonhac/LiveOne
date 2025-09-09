import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import type { CommonPollingData } from '@/lib/types/common';

interface CraighackSystemForPolling {
  id: number;
  ownerClerkUserId: string | null;
  vendorSiteId: string;
}

/**
 * Poll a Craighack system by combining data from two other systems:
 * - Solar data from systemId=3
 * - Battery, load, and grid data from systemId=2
 */
export async function pollCraighackSystem(system: CraighackSystemForPolling): Promise<CommonPollingData | null> {
  console.log(`[Craighack] Polling combined system ${system.vendorSiteId}...`);
  
  // Get the latest reading from system 3 (solar data)
  const solarReading = await db.select()
    .from(readings)
    .where(eq(readings.systemId, 3))
    .orderBy(desc(readings.inverterTime))
    .limit(1);
    
  if (!solarReading || solarReading.length === 0) {
    console.log('[Craighack] No solar data available from system 3');
    return null;
  }
  
  // Get the latest reading from system 2 (battery, load, grid data)
  const batteryReading = await db.select()
    .from(readings)
    .where(eq(readings.systemId, 2))
    .orderBy(desc(readings.inverterTime))
    .limit(1);
    
  if (!batteryReading || batteryReading.length === 0) {
    console.log('[Craighack] No battery/load/grid data available from system 2');
    return null;
  }
  
  const solar = solarReading[0];
  const battery = batteryReading[0];
  
  // Use the most recent timestamp between the two systems
  const mostRecentTime = solar.inverterTime > battery.inverterTime ? solar.inverterTime : battery.inverterTime;
  
  // Check if data is too stale (more than 5 minutes old)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  if (mostRecentTime < fiveMinutesAgo) {
    console.log('[Craighack] Data is too stale, skipping');
    return null;
  }
  
  // Combine the data
  const pollingData: CommonPollingData = {
    timestamp: mostRecentTime.toISOString(),
    // Solar data from system 3
    solarW: solar.solarW,
    solarInverterW: solar.solarInverterW,
    shuntW: solar.shuntW,
    // Battery, load, grid data from system 2
    loadW: battery.loadW,
    batteryW: battery.batteryW,
    gridW: battery.gridW,
    batterySOC: battery.batterySOC,
    // Use battery system's fault and generator status
    faultCode: battery.faultCode,
    faultTimestamp: battery.faultTimestamp,
    generatorStatus: battery.generatorStatus,
    // Energy counters - combine from both systems
    solarKwhTotal: solar.solarKwhTotal || 0,
    loadKwhTotal: battery.loadKwhTotal || 0,
    batteryInKwhTotal: battery.batteryInKwhTotal || 0,
    batteryOutKwhTotal: battery.batteryOutKwhTotal || 0,
    gridInKwhTotal: battery.gridInKwhTotal || 0,
    gridOutKwhTotal: battery.gridOutKwhTotal || 0
  };
  
  console.log(`[Craighack] Poll successful -`,
    'Solar:', pollingData.solarW, 'W (from system 3)',
    'Load:', pollingData.loadW, 'W (from system 2)',
    'Battery:', pollingData.batteryW, 'W (from system 2)',
    'SOC:', pollingData.batterySOC.toFixed(1), '%');
  
  return pollingData;
}