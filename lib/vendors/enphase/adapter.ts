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
import { getPollingStatus } from '@/lib/polling-utils';

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

      // Fetch today's data to verify connection works
      const result = await fetchEnphaseDay(
        system.id,
        null, // null means fetch today
        system.timezoneOffsetMin,
        true  // dryRun - don't actually save to database during test
      );

      // Get the most recent reading from the database to show current status
      const latestReading = await this.getLastReading(system.id);

      // Convert to test connection format
      const latestData = latestReading ? {
        timestamp: latestReading.timestamp,
        solarW: latestReading.solar?.powerW || null,
        solarLocalW: latestReading.solar?.localW || null,
        loadW: latestReading.load?.powerW || null,
        batteryW: latestReading.battery?.powerW || null,
        gridW: latestReading.grid?.powerW || null,
        batterySOC: latestReading.battery?.soc || null,
        faultCode: latestReading.connection?.faultCode || null,
        faultTimestamp: latestReading.connection?.faultTimestamp
          ? new Date(latestReading.connection.faultTimestamp * 1000)  // Convert Unix seconds to Date
          : null,
        generatorStatus: latestReading.grid?.generatorStatus || null,
        solarKwhTotal: null,
        loadKwhTotal: null,
        batteryInKwhTotal: null,
        batteryOutKwhTotal: null,
        gridInKwhTotal: null,
        gridOutKwhTotal: null
      } : null;

      // System info
      const systemInfo = {
        model: 'Enphase System',
        serial: system.vendorSiteId,
        ratings: null,
        solarSize: null,
        batterySize: null
      };

      console.log(`[Enphase] Test connection successful for system ${system.vendorSiteId}`);
      console.log(`[Enphase] Would have fetched ${result.intervalCount} intervals`);

      return {
        success: true,
        systemInfo,
        latestData: latestData || undefined,
        vendorResponse: result.rawResponse  // Return the raw Enphase production data
      };
    } catch (error) {
      console.error('Error testing Enphase connection:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
}