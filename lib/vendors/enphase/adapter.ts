import { BaseVendorAdapter, type ScheduleEvaluation } from "../base-adapter";
import type { PollingResult, TestConnectionResult } from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import { db } from "@/lib/db";
import { pointReadingsAgg5m } from "@/lib/db/schema-monitoring-points";
import { eq, and, desc } from "drizzle-orm";
import {
  checkAndFetchYesterdayIfNeeded,
  fetchEnphaseDay,
} from "@/lib/vendors/enphase/enphase-history";
import {
  getZonedNow,
  formatJustTime_fromJSDate,
  getNextMinuteBoundary,
} from "@/lib/date-utils";
import { fromDate, type ZonedDateTime } from "@internationalized/date";
import { getPollingStatus } from "@/lib/polling-utils";
import { sessionManager } from "@/lib/session-manager";
import * as SunCalc from "suncalc";

/**
 * Vendor adapter for Enphase systems
 * Polls every 30 minutes during daylight hours due to API rate limits
 */
// Configuration constants
const ENPHASE_POLLING_INTERVAL_MINUTES = 60; // How often to poll during daylight hours

export class EnphaseAdapter extends BaseVendorAdapter {
  readonly vendorType = "enphase";
  readonly displayName = "Enphase";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = false; // Enphase uses OAuth flow, not supported in Add System dialog yet

  // Enphase has custom schedule logic - polls every 60 minutes during daylight hours
  protected pollIntervalMinutes = 60;
  protected toleranceSeconds = 60;

  /**
   * Override getLastReading to read from point_readings_agg_5m table
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    // Find the Enphase solar power point for this system
    const solarPoint =
      await PointManager.getInstance().getPointByPhysicalPathTail(
        systemId,
        "solar_w",
      );

    if (!solarPoint) {
      return null;
    }

    // Get the latest 5-minute aggregate for this point
    const [latestAgg] = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, systemId),
          eq(pointReadingsAgg5m.pointId, solarPoint.index),
        ),
      )
      .orderBy(desc(pointReadingsAgg5m.intervalEnd))
      .limit(1);

    if (!latestAgg) {
      return null;
    }

    // Convert Unix milliseconds to Date
    const timestamp = new Date(latestAgg.intervalEnd);

    return {
      timestamp: timestamp,
      receivedTime: latestAgg.createdAt
        ? new Date(latestAgg.createdAt)
        : timestamp, // Fall back to timestamp if createdAt is null

      solar: {
        powerW: latestAgg.avg,
        localW: latestAgg.avg, // Enphase measures at the panels
        remoteW: null, // Enphase doesn't have remote solar
      },

      battery: {
        powerW: null, // Enphase production endpoint doesn't provide battery data
        soc: null,
      },

      load: {
        powerW: null, // Enphase production endpoint doesn't provide load data
      },

      grid: {
        powerW: null, // Enphase production endpoint doesn't provide grid data
        generatorStatus: null,
      },

      connection: {
        faultCode: null, // Enphase doesn't provide fault codes
        faultTimestamp: null,
      },
    };
  }

  /**
   * Override evaluateSchedule for Enphase-specific solar-aware logic
   * Poll every 60 minutes from 30 mins after dawn to 30 mins after dusk,
   * then hourly from 01:00-05:00 for yesterday's data
   */
  protected evaluateSchedule(
    system: SystemWithPolling,
    lastPollTime: Date | null,
    now: Date,
  ): ScheduleEvaluation {
    // Always poll if never polled before
    if (!lastPollTime) {
      console.log(`[Enphase] Never polled, polling now`);
      const nextPollTime = getNextMinuteBoundary(60, system.timezoneOffsetMin); // Next hour boundary
      return {
        shouldPoll: true,
        reason: "Never polled",
        nextPollTime,
      };
    }

    // Get location for sunrise/sunset calculation
    let lat = -37.8136; // Melbourne default
    let lon = 144.9631;

    if (system.location) {
      try {
        const loc =
          typeof system.location === "string"
            ? JSON.parse(system.location)
            : system.location;
        if (loc.lat && loc.lon) {
          lat = loc.lat;
          lon = loc.lon;
        }
      } catch (e) {
        console.log(`[Enphase] Using default location`);
      }
    }

    // Calculate local time for the system
    const utcTime = now.getTime();
    const localOffset = system.timezoneOffsetMin * 60 * 1000;
    const localTime = new Date(utcTime + localOffset);
    const localHour = localTime.getUTCHours();
    const localMinutes = localTime.getUTCMinutes();
    const localTimeMinutes = localHour * 60 + localMinutes;

    // Calculate sun times for today
    const sunTimes = SunCalc.getTimes(now, lat, lon);
    const dawnUTC = sunTimes.dawn;
    const duskUTC = sunTimes.dusk;

    // Convert to local time
    const dawnLocalTime = new Date(dawnUTC.getTime() + localOffset);
    const duskLocalTime = new Date(duskUTC.getTime() + localOffset);

    let dawnMinutes =
      dawnLocalTime.getUTCHours() * 60 + dawnLocalTime.getUTCMinutes();
    let duskMinutes =
      duskLocalTime.getUTCHours() * 60 + duskLocalTime.getUTCMinutes();

    if (duskMinutes < dawnMinutes) {
      duskMinutes += 24 * 60;
    }

    // Active hours: first 30-min boundary after dawn to 30 mins after dusk
    const activeStart = Math.ceil(dawnMinutes / 30) * 30;
    const activeEnd = duskMinutes + 30;

    // Check if we're in active solar hours
    if (localTimeMinutes >= activeStart && localTimeMinutes <= activeEnd) {
      const msSinceLastPoll = now.getTime() - lastPollTime.getTime();
      const targetIntervalMs = ENPHASE_POLLING_INTERVAL_MINUTES * 60 * 1000;
      const toleranceMs = this.toleranceSeconds * 1000;

      if (msSinceLastPoll >= targetIntervalMs - toleranceMs) {
        const nextPollTime = getNextMinuteBoundary(
          ENPHASE_POLLING_INTERVAL_MINUTES,
          system.timezoneOffsetMin,
        );
        return {
          shouldPoll: true,
          reason: "Solar hours polling interval reached",
          nextPollTime,
        };
      }

      const nextPollTime = getNextMinuteBoundary(
        ENPHASE_POLLING_INTERVAL_MINUTES,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: false,
        reason: `Active solar hours (next poll at ${formatJustTime_fromJSDate(nextPollTime.toDate(), system.timezoneOffsetMin)})`,
        nextPollTime,
      };
    }

    // Night-time hourly check (01:00-05:00)
    if (localHour >= 1 && localHour <= 5) {
      const msSinceLastPoll = now.getTime() - lastPollTime.getTime();
      const targetIntervalMs = 60 * 60 * 1000; // Hourly
      const toleranceMs = this.toleranceSeconds * 1000;

      if (msSinceLastPoll >= targetIntervalMs - toleranceMs) {
        const nextPollTime = getNextMinuteBoundary(
          60,
          system.timezoneOffsetMin,
        ); // Hourly
        return {
          shouldPoll: true,
          reason: "Night-time hourly check",
          nextPollTime,
        };
      }

      const nextPollTime = getNextMinuteBoundary(60, system.timezoneOffsetMin); // Hourly
      return {
        shouldPoll: false,
        reason: `Night-time check period (next at ${formatJustTime_fromJSDate(nextPollTime.toDate(), system.timezoneOffsetMin)})`,
        nextPollTime,
      };
    }

    // Outside active hours - calculate next poll time
    let nextPollTime: ZonedDateTime;
    let reason: string;

    if (localTimeMinutes < activeStart) {
      // Before dawn - poll at dawn (rounded to next hour boundary)
      const minutesUntilDawn = activeStart - localTimeMinutes;
      const dawnTime = new Date(now.getTime() + minutesUntilDawn * 60 * 1000);

      // Get next hour boundary after dawn time
      nextPollTime = getNextMinuteBoundary(
        60,
        system.timezoneOffsetMin,
        dawnTime,
      );

      const hoursUntil = Math.floor(minutesUntilDawn / 60);
      const minsUntil = minutesUntilDawn % 60;
      reason =
        hoursUntil > 0
          ? `Before dawn (next poll in ${hoursUntil}h ${minsUntil}m)`
          : `Before dawn (next poll in ${minsUntil}m)`;
    } else {
      // After dusk - next poll is tomorrow at 01:00 or dawn, whichever is earlier
      const tomorrow1AM = 25 * 60; // 01:00 tomorrow
      const tomorrowDawn = activeStart + 24 * 60;
      const nextPollMinutes = Math.min(tomorrow1AM, tomorrowDawn);
      const minutesUntilNext = nextPollMinutes - localTimeMinutes;
      const targetTime = new Date(now.getTime() + minutesUntilNext * 60 * 1000);

      // Get next hour boundary after target time
      nextPollTime = getNextMinuteBoundary(
        60,
        system.timezoneOffsetMin,
        targetTime,
      );

      const hoursUntil = Math.floor(minutesUntilNext / 60);
      const minsUntil = minutesUntilNext % 60;
      reason =
        hoursUntil > 0
          ? `After dusk (next poll in ${hoursUntil}h ${minsUntil}m)`
          : `After dusk (next poll in ${minsUntil}m)`;
    }

    return {
      shouldPoll: false,
      reason,
      nextPollTime,
    };
  }

  /**
   * Perform the actual polling
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: any,
    session: SessionInfo,
    pollReason: string,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    const startTime = Date.now();

    try {
      console.log(
        `[Enphase] Polling system ${system.id} (${system.displayName})`,
      );

      // Determine what to fetch
      let result;
      const localTime = getZonedNow(system.timezoneOffsetMin);
      const localHour = localTime.hour;

      if (localHour >= 1 && localHour <= 5) {
        // During 01:00-05:00, check and fetch yesterday's data if incomplete
        console.log(
          `[Enphase] Checking yesterday's data completeness for system ${system.id}`,
        );
        result = await checkAndFetchYesterdayIfNeeded(
          system.id,
          session,
          dryRun,
        );
      } else {
        // Otherwise fetch current day's data
        result = await fetchEnphaseDay(
          system.id,
          null,
          system.timezoneOffsetMin,
          session,
          dryRun,
        );
      }

      // Determine records upserted
      let recordsUpserted = 0;
      if ("upsertedCount" in result) {
        recordsUpserted = result.upsertedCount;
      } else if ("fetched" in result && !result.fetched) {
        // Yesterday's data was already complete
        recordsUpserted = 0;
      }

      const duration = Date.now() - startTime;
      console.log(
        `[Enphase] System ${system.id}: Upserted ${recordsUpserted} records in ${duration}ms`,
      );

      // Get raw response if available
      const rawResponse =
        "rawResponse" in result ? result.rawResponse : undefined;

      // Calculate next poll time
      const now = new Date();
      const evaluation = this.evaluateSchedule(
        system,
        system.pollingStatus?.lastPollTime || null,
        now,
      );
      const nextPoll = evaluation.nextPollTime; // Already a ZonedDateTime

      // Note: Enphase returns multiple records (5-minute intervals)
      // The data is already stored by fetchEnphaseDay, so we don't return it here
      return this.polled(
        [], // Data already stored by fetchEnphaseDay
        recordsUpserted,
        nextPoll,
        rawResponse,
      );
    } catch (error) {
      console.error(`[Enphase] Error polling system ${system.id}:`, error);
      return this.error(error instanceof Error ? error : "Unknown error");
    }
  }

  // getMostRecentReadings removed - not used externally

  async testConnection(
    system: SystemWithPolling,
    credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      console.log(`[Enphase] Testing connection for system ${system.id}`);

      // Create a session for this test connection
      const session = await sessionManager.createSession({
        systemId: system.id,
        cause: "USER-TEST",
        started: new Date(),
      });

      // Fetch today's data to verify connection works
      const result = await fetchEnphaseDay(
        system.id,
        null, // null means fetch today
        system.timezoneOffsetMin,
        session,
        true, // dryRun - don't actually save to database during test
      );

      // Get the most recent reading from the database to show current status
      const latestReading = await this.getLastReading(system.id);

      // Convert to test connection format
      const latestData = latestReading
        ? {
            timestamp: latestReading.timestamp,
            solarW: latestReading.solar?.powerW || null,
            solarLocalW: latestReading.solar?.localW || null,
            loadW: latestReading.load?.powerW || null,
            batteryW: latestReading.battery?.powerW || null,
            gridW: latestReading.grid?.powerW || null,
            batterySOC: latestReading.battery?.soc || null,
            faultCode: latestReading.connection?.faultCode || null,
            faultTimestamp: latestReading.connection?.faultTimestamp
              ? new Date(latestReading.connection.faultTimestamp * 1000) // Convert Unix seconds to Date
              : null,
            generatorStatus: latestReading.grid?.generatorStatus || null,
            solarKwhTotal: null,
            loadKwhTotal: null,
            batteryInKwhTotal: null,
            batteryOutKwhTotal: null,
            gridInKwhTotal: null,
            gridOutKwhTotal: null,
          }
        : null;

      // System info
      const systemInfo = {
        model: "Enphase System",
        serial: system.vendorSiteId,
        ratings: null,
        solarSize: null,
        batterySize: null,
      };

      console.log(
        `[Enphase] Test connection successful for system ${system.vendorSiteId}`,
      );
      console.log(
        `[Enphase] Would have fetched ${result.intervalCount} intervals`,
      );

      return {
        success: true,
        systemInfo,
        latestData: latestData || undefined,
        vendorResponse: result.rawResponse, // Return the raw Enphase production data
      };
    } catch (error) {
      console.error("Error testing Enphase connection:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
