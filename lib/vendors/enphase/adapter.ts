import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import type { LatestReadingData } from '@/lib/types/readings';
import { db } from '@/lib/db';
import { readingsAgg5m } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { checkEnphasePollingSchedule } from '@/lib/vendors/enphase/enphase-cron';
import { checkAndFetchYesterdayIfNeeded, fetchEnphaseDay } from '@/lib/vendors/enphase/enphase-history';
import { getZonedNow } from '@/lib/date-utils';
import { fetchWithEnphaseAuth } from '@/lib/vendors/enphase/enphase-auth';
import { getPollingStatus } from '@/lib/polling-utils';
import { CalendarDate } from '@internationalized/date';
import type { EnphaseTelemetryResponse } from './types';

/**
 * Vendor adapter for Enphase systems
 * Polls every 30 minutes during daylight hours due to API rate limits
 */
export class EnphaseAdapter extends BaseVendorAdapter {
  readonly vendorType = 'enphase';
  readonly displayName = 'Enphase';
  readonly dataSource = 'poll' as const;
  readonly supportsAddSystem = false;  // Enphase uses OAuth flow, not supported in Add System dialog yet

  /**
   * Override getLastReading to read from readings_agg_5m table
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    const [latestAgg] = await db.select()
      .from(readingsAgg5m)
      .where(eq(readingsAgg5m.systemId, systemId))
      .orderBy(desc(readingsAgg5m.intervalEnd))
      .limit(1);

    if (!latestAgg) {
      return null;
    }

    // Convert Unix timestamp to Date
    const timestamp = new Date(latestAgg.intervalEnd * 1000);

    return {
      timestamp: timestamp,
      receivedTime: latestAgg.createdAt,

      solar: {
        powerW: latestAgg.solarWAvg,
        localW: latestAgg.solarWAvg,  // Enphase measures at the panels
        remoteW: null,  // Enphase doesn't have remote solar
      },

      battery: {
        powerW: latestAgg.batteryWAvg,
        soc: latestAgg.batterySOCLast,
      },

      load: {
        powerW: latestAgg.loadWAvg,
      },

      grid: {
        powerW: latestAgg.gridWAvg,
        generatorStatus: null,  // Enphase doesn't have generator status
      },

      connection: {
        faultCode: null,  // Enphase doesn't provide fault codes
        faultTimestamp: null,
      },
    };
  }

  /**
   * Fetch latest telemetry using centralized auth (handles token refresh)
   */
  private async fetchTelemetryWithAuth(system: SystemForVendor): Promise<EnphaseTelemetryResponse> {
    // Clean up the system ID
    const cleanSystemId = String(system.vendorSiteId).replace(/\.0$/, '').split('.')[0];

    // Build the URL
    const url = `https://api.enphaseenergy.com/api/v4/systems/${cleanSystemId}/summary`;

    // Fetch with automatic token refresh
    const response = await fetchWithEnphaseAuth(
      {
        id: system.id,
        ownerClerkUserId: system.ownerClerkUserId,
        vendorSiteId: system.vendorSiteId
      },
      url
    );

    if (!response.ok) {
      throw new Error(`Telemetry fetch failed: ${response.status}`);
    }

    const data = await response.json();

    // Convert to our expected telemetry response format
    const telemetryResponse: EnphaseTelemetryResponse = {
      system_id: cleanSystemId,
      production_power: data.current_power ?? null,
      consumption_power: null, // Summary endpoint doesn't provide consumption
      storage_power: null,
      storage_soc: null,
      grid_power: null,
      energy_today: data.energy_today ?? null,
      energy_lifetime: data.energy_lifetime ?? null,
      system_size: data.size_w ?? null,
      last_report_at: data.last_report_at ?? null,
      raw: data,
      rawResponse: data
    };

    return telemetryResponse;
  }
  
  async poll(system: SystemForVendor, credentials: any): Promise<PollingResult> {
    const startTime = Date.now();
    
    try {
      // Check polling schedule (every 30 minutes during daylight hours)
      const status = await getPollingStatus(system.id);
      const lastPollTime = status?.lastPollTime || null;
      
      const scheduleCheck = checkEnphasePollingSchedule(
        system as any, // System has ownerClerkUserId
        lastPollTime
      );
      
      if (!scheduleCheck.shouldPollNow) {
        return this.skipped(
          scheduleCheck.skipReason || 'Outside polling schedule',
          undefined // TODO: Convert nextPollTimeStr to Date if needed
        );
      }
      
      console.log(`[Enphase] Polling system ${system.id} (${system.displayName})`);
      
      // Determine what to fetch
      let result;
      const localTime = getZonedNow(system.timezoneOffsetMin);
      const localHour = localTime.hour;
      
      if (localHour >= 1 && localHour <= 5) {
        // During 01:00-05:00, check and fetch yesterday's data if incomplete
        console.log(`[Enphase] Checking yesterday's data completeness for system ${system.id}`);
        result = await checkAndFetchYesterdayIfNeeded(system.id, false);
      } else {
        // Otherwise fetch current day's data
        result = await fetchEnphaseDay(system.id, null, system.timezoneOffsetMin, false);
      }
      
      // Determine records upserted
      let recordsUpserted = 0;
      if ('upsertedCount' in result) {
        recordsUpserted = result.upsertedCount;
      } else if ('fetched' in result && !result.fetched) {
        // Yesterday's data was already complete
        recordsUpserted = 0;
      }
      
      const duration = Date.now() - startTime;
      console.log(`[Enphase] System ${system.id}: Upserted ${recordsUpserted} records in ${duration}ms`);
      
      // Calculate next poll time (30 minutes during daylight)
      const nextPoll = new Date(Date.now() + 30 * 60 * 1000);
      
      // Note: Enphase returns multiple records (5-minute intervals)
      // The data is already stored by fetchEnphaseDay, so we don't return it here
      return this.polled(
        [], // Data already stored by fetchEnphaseDay
        recordsUpserted,
        nextPoll
      );
      
    } catch (error) {
      console.error(`[Enphase] Error polling system ${system.id}:`, error);
      return this.error(error instanceof Error ? error : 'Unknown error');
    }
  }
  
  // getMostRecentReadings removed - not used externally
  
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    try {
      console.log(`[Enphase] Testing connection for system ${system.id}`);

      // Fetch telemetry with automatic token refresh
      const telemetry = await this.fetchTelemetryWithAuth(system);

      // Clean up the system ID for display
      const cleanSystemId = String(system.vendorSiteId).replace(/\.0$/, '').split('.')[0];

      // Only use real data - no made up values
      const latestData = telemetry ? {
        timestamp: new Date().toISOString(),
        solarW: telemetry.production_power || null,
        solarLocalW: telemetry.production_power || null,
        loadW: telemetry.consumption_power || null,
        batteryW: telemetry.storage_power || null,
        gridW: telemetry.grid_power || null,
        batterySOC: telemetry.storage_soc || null,
        faultCode: null,
        faultTimestamp: null,
        generatorStatus: null,
        solarKwhTotal: telemetry.production_energy_lifetime ? telemetry.production_energy_lifetime / 1000 : null,
        loadKwhTotal: telemetry.consumption_energy_lifetime ? telemetry.consumption_energy_lifetime / 1000 : null,
        batteryInKwhTotal: telemetry.storage_energy_charged ? telemetry.storage_energy_charged / 1000 : null,
        batteryOutKwhTotal: telemetry.storage_energy_discharged ? telemetry.storage_energy_discharged / 1000 : null,
        gridInKwhTotal: null,
        gridOutKwhTotal: null
      } : null;

      // System info - only real data
      const systemInfo = {
        model: 'Enphase System',
        serial: cleanSystemId,
        ratings: null,
        solarSize: null,
        batterySize: null
      };

      console.log(`[Enphase] Test connection successful for system ${cleanSystemId}`);

      return {
        success: true,
        systemInfo,
        latestData: latestData || undefined,
        vendorResponse: telemetry // Return the raw response from the server
      };
    } catch (error) {
      console.error('Error testing Enphase connection:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
  /**
   * Transform Enphase telemetry data to common format
   */
  private transformTelemetryData(telemetry: any): CommonPollingData | null {
    if (!telemetry) return null;
    
    // Use actual values or 0 for missing data
    const currentPower = telemetry.production_power ?? 0;
    const consumptionPower = telemetry.consumption_power ?? 0;
    const batteryPower = telemetry.storage_power ?? 0;
    const gridPower = telemetry.grid_power ?? 0;
    const batterySOC = telemetry.storage_soc ?? 0;
    
    return {
      timestamp: new Date().toISOString(),
      solarW: currentPower,
      solarLocalW: currentPower,  // Enphase measures at the panels/microinverters
      loadW: consumptionPower,
      batteryW: batteryPower,
      gridW: gridPower,
      batterySOC: batterySOC,
      faultCode: null,  // Enphase doesn't provide fault codes
      faultTimestamp: null,  // No fault timestamp when no faults
      generatorStatus: null,  // Enphase doesn't provide generator status
      // Energy totals - Enphase provides these in Wh, convert to kWh
      solarKwhTotal: telemetry.production_energy_lifetime 
        ? telemetry.production_energy_lifetime / 1000 : 0,
      loadKwhTotal: telemetry.consumption_energy_lifetime 
        ? telemetry.consumption_energy_lifetime / 1000 : 0,
      batteryInKwhTotal: telemetry.storage_energy_charged 
        ? telemetry.storage_energy_charged / 1000 : 0,
      batteryOutKwhTotal: telemetry.storage_energy_discharged 
        ? telemetry.storage_energy_discharged / 1000 : 0,
      gridInKwhTotal: 0, // Enphase doesn't provide separate grid in/out
      gridOutKwhTotal: 0
    };
  }
}