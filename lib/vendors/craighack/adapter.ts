import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * Vendor adapter for CraigHack systems
 * CraigHack systems don't poll - they combine data from other systems
 */
export class CraigHackAdapter extends BaseVendorAdapter {
  readonly vendorType = 'craighack';
  readonly displayName = 'CraigHack';
  readonly dataSource = 'push' as const;  // CraigHack doesn't poll, it aggregates from other systems
  
  // CraigHack is combined-source, poll() is not implemented (handled by base class)
  
  async getMostRecentReadings(system: SystemForVendor, credentials: any): Promise<CommonPollingData | null> {
    try {
      // CraigHack combines data from systems 2 (Selectronic) and 3 (Enphase)
      // Get the most recent readings from both systems
      
      const [system2Reading] = await db
        .select()
        .from(readings)
        .where(eq(readings.systemId, 2))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      const [system3Reading] = await db
        .select()
        .from(readings)
        .where(eq(readings.systemId, 3))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      if (!system2Reading) {
        console.log('[CraigHack] No recent data from system 2 (Selectronic)');
        return null;
      }
      
      // Combine the data
      // Use solar from system 3 (Enphase) if available, otherwise from system 2
      const solarW = system3Reading?.solarW ?? system2Reading.solarW;
      
      // Use all other data from system 2 (Selectronic)
      return {
        timestamp: system2Reading.inverterTime.toISOString(),
        solarW: solarW,
        solarRemoteW: system2Reading.solarRemoteW,
        solarLocalW: system2Reading.solarLocalW,
        loadW: system2Reading.loadW,
        batteryW: system2Reading.batteryW,
        gridW: system2Reading.gridW,
        batterySOC: system2Reading.batterySOC,
        faultCode: system2Reading.faultCode != null ? String(system2Reading.faultCode) : null,
        faultTimestamp: system2Reading.faultTimestamp || null,  // Convert 0 to null when no fault
        generatorStatus: system2Reading.generatorStatus || null,  // Convert 0 to null when no generator
        // Lifetime totals
        solarKwhTotal: system3Reading?.solarKwhTotal ?? system2Reading.solarKwhTotal,
        loadKwhTotal: system2Reading.loadKwhTotal,
        batteryInKwhTotal: system2Reading.batteryInKwhTotal,
        batteryOutKwhTotal: system2Reading.batteryOutKwhTotal,
        gridInKwhTotal: system2Reading.gridInKwhTotal,
        gridOutKwhTotal: system2Reading.gridOutKwhTotal
      };
      
    } catch (error) {
      console.error(`[CraigHack] Error getting recent readings: ${error}`);
      return null;
    }
  }
  
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    try {
      // Check if source systems have recent data (within last 5 minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      const [system2Recent] = await db
        .select()
        .from(readings)
        .where(eq(readings.systemId, 2))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      const [system3Recent] = await db
        .select()
        .from(readings)
        .where(eq(readings.systemId, 3))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      const system2HasRecentData = system2Recent && system2Recent.inverterTime > fiveMinutesAgo;
      const system3HasRecentData = system3Recent && system3Recent.inverterTime > fiveMinutesAgo;
      
      if (!system2HasRecentData && !system3HasRecentData) {
        return {
          success: false,
          error: 'Both source systems missing recent data'
        };
      }
      
      if (!system2HasRecentData) {
        return {
          success: false,
          error: 'System 2 (Selectronic) missing recent data'
        };
      }
      
      // Get combined data
      const latestData = await this.getMostRecentReadings(system, credentials);
      
      return {
        success: true,
        systemInfo: {
          model: 'Combined System',
          serial: `CRAIG-${system.vendorSiteId}`,
          ratings: null,
          solarSize: null,
          batterySize: null
        },
        latestData: latestData || undefined
      };
      
    } catch (error) {
      console.error('Error testing CraigHack connection:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}