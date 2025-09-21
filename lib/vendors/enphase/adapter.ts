import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import { checkEnphasePollingSchedule } from '@/lib/enphase/enphase-cron';
import { checkAndFetchYesterdayIfNeeded, fetchEnphaseDay } from '@/lib/enphase/enphase-history';
import { getZonedNow } from '@/lib/date-utils';
import { getEnphaseClient } from '@/lib/enphase/enphase-client';
import { getPollingStatus } from '@/lib/polling-utils';
import { CalendarDate } from '@internationalized/date';

/**
 * Vendor adapter for Enphase systems
 * Polls every 30 minutes during daylight hours due to API rate limits
 */
export class EnphaseAdapter extends BaseVendorAdapter {
  readonly vendorType = 'enphase';
  readonly displayName = 'Enphase';
  readonly dataSource = 'poll' as const;
  
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
  
  async getMostRecentReadings(system: SystemForVendor, credentials: any): Promise<CommonPollingData | null> {
    try {
      // For Enphase, we fetch current telemetry from the API
      const client = getEnphaseClient();
      
      // Check if token is expired
      if (credentials.expires_at < Date.now()) {
        console.error('[Enphase] Token expired');
        return null;
      }
      
      // Clean up the system ID
      const cleanSystemId = String(system.vendorSiteId).replace(/\.0$/, '').split('.')[0];
      
      // Fetch latest telemetry
      const telemetry = await client.getLatestTelemetry(
        cleanSystemId,
        credentials.access_token
      );
      
      // Transform to common format
      return this.transformTelemetryData(telemetry);
      
    } catch (error) {
      console.error(`[Enphase] Error getting recent readings: ${error}`);
      return null;
    }
  }
  
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    try {
      // Check if token is expired
      if (credentials.expires_at < Date.now()) {
        return {
          success: false,
          error: 'Enphase token expired. Please reconnect your system.'
        };
      }
      
      // Create Enphase client
      const client = getEnphaseClient();
      
      // Clean up the system ID
      const cleanSystemId = String(system.vendorSiteId).replace(/\.0$/, '').split('.')[0];
      
      // Fetch latest telemetry data
      const telemetry = await client.getLatestTelemetry(
        cleanSystemId,
        credentials.access_token
      );
      
      const latestData = this.transformTelemetryData(telemetry);
      
      // Extract system info from telemetry
      const systemInfo = {
        model: 'Enphase System',
        serial: cleanSystemId,
        ratings: null,
        solarSize: telemetry.system_size 
          ? `${(telemetry.system_size / 1000).toFixed(1)} kW`
          : latestData?.solarW 
          ? `${(latestData.solarW / 1000).toFixed(1)} kW capacity` 
          : null,
        batterySize: telemetry.storage_soc && telemetry.storage_soc > 0 
          ? 'Battery present' 
          : null
      };
      
      console.log(`[Enphase] Test connection successful for system ${cleanSystemId}`);
      
      return {
        success: true,
        systemInfo,
        latestData: latestData || undefined,
        vendorResponse: telemetry.raw // Include raw vendor response
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
      faultCode: 0,
      faultTimestamp: 0,
      generatorStatus: 0,
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