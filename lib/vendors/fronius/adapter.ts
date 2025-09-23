import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * Vendor adapter for Fronius systems
 * Fronius systems use push-based data collection
 * The inverter pushes data to our endpoint, we queue it, and process it here
 */
export class FroniusAdapter extends BaseVendorAdapter {
  readonly vendorType = 'fronius';
  readonly displayName = 'Fronius';
  readonly dataSource = 'push' as const;
  
  // Fronius is push-only, poll() is not implemented (handled by base class)
  
  async getMostRecentReadings(system: SystemForVendor, credentials: any): Promise<CommonPollingData | null> {
    try {
      // For push-based systems, get the most recent reading from the database
      const [recentReading] = await db
        .select()
        .from(readings)
        .where(eq(readings.systemId, system.id))
        .orderBy(desc(readings.inverterTime))
        .limit(1);
      
      if (!recentReading) {
        return null;
      }
      
      // Convert DB reading back to CommonPollingData format
      return {
        timestamp: recentReading.inverterTime.toISOString(),
        solarW: recentReading.solarW,
        solarLocalW: recentReading.solarLocalW,
        solarRemoteW: recentReading.solarRemoteW,
        loadW: recentReading.loadW,
        batteryW: recentReading.batteryW,
        gridW: recentReading.gridW,
        batterySOC: recentReading.batterySOC,
        faultCode: recentReading.faultCode != null ? String(recentReading.faultCode) : null,
        faultTimestamp: recentReading.faultTimestamp || null,  // Convert 0 to null when no fault
        generatorStatus: recentReading.generatorStatus || null  // Convert 0 to null when no generator
      };
    } catch (error) {
      console.error(`[Fronius] Error getting recent readings: ${error}`);
      return null;
    }
  }
  
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    // For push-based systems, check if we have recent data
    const latestData = await this.getMostRecentReadings(system, credentials);
    
    if (!latestData) {
      return {
        success: false,
        error: 'No data received from Fronius system yet. Ensure push endpoint is configured.'
      };
    }
    
    // Check if data is recent (within last 15 minutes)
    const dataAge = Date.now() - new Date(latestData.timestamp).getTime();
    const isRecent = dataAge < 15 * 60 * 1000;
    
    if (!isRecent) {
      return {
        success: false,
        error: `Last data received ${Math.round(dataAge / 60000)} minutes ago. Check Fronius push configuration.`
      };
    }
    
    return {
      success: true,
      systemInfo: {
        model: 'Fronius System',
        serial: system.vendorSiteId,
        ratings: null,
        solarSize: null,
        batterySize: null
      },
      latestData
    };
  }
}