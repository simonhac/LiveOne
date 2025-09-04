import { db } from '@/lib/db';
import { systems, pollingStatus } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { fetchEnphaseCurrentDay, checkAndFetchYesterdayIfNeeded, fetchEnphase5MinDay } from './enphase-history';
import { getZonedNow } from '@/lib/date-utils';
import * as SunCalc from 'suncalc';
import { CalendarDate } from '@internationalized/date';

// Type for systems we've already validated have an owner
interface EnphaseSystemWithOwner {
  id: number;
  vendorSiteId: string;
  ownerClerkUserId: string;
  timezoneOffsetMin: number;
  location: any;
}

/**
 * Calculate if we should poll an Enphase system based on smart schedule
 * Poll every 30 mins from 30 mins before dawn to 30 mins after dusk,
 * then 1 hour later, then at midnight
 */
export function shouldPollEnphaseNow(
  system: EnphaseSystemWithOwner, 
  lastPollTime: Date | null,
  currentTime: Date = new Date()
): boolean {
  // Always poll if never polled before
  if (!lastPollTime) {
    console.log(`[ENPHASE] Never polled, polling now`);
    return true;
  }
  
  // Calculate minutes since last poll
  const minutesSinceLastPoll = Math.floor((currentTime.getTime() - lastPollTime.getTime()) / 60000);
  
  // Don't poll more frequently than every 25 minutes (to account for slight timing variations)
  if (minutesSinceLastPoll < 25) {
    console.log(`[ENPHASE] Skipping - polled ${minutesSinceLastPoll} minutes ago (minimum 25 min interval)`);
    return false;
  }
  
  // Get location for sunrise/sunset calculation
  let lat = -37.8136; // Melbourne default
  let lon = 144.9631;
  
  if (system.location) {
    try {
      const loc = typeof system.location === 'string' 
        ? JSON.parse(system.location) 
        : system.location;
      if (loc.lat && loc.lon) {
        lat = loc.lat;
        lon = loc.lon;
      }
    } catch (e) {
      console.log(`[ENPHASE] Using default location`);
    }
  }
  
  // Calculate local time for the system
  // Note: timezoneOffsetMin is minutes AHEAD of UTC (positive for east of UTC)
  const utcTime = currentTime.getTime();
  const localOffset = system.timezoneOffsetMin * 60 * 1000;
  const localTime = new Date(utcTime + localOffset);
  const localHour = localTime.getUTCHours(); // Use UTC methods since we manually applied offset
  const localMinutes = localTime.getUTCMinutes();
  const localTimeMinutes = localHour * 60 + localMinutes;
  
  // Calculate sun times for today (SunCalc returns times in UTC)
  const sunTimes = SunCalc.getTimes(currentTime, lat, lon);
  
  // Dawn and dusk in UTC
  const dawnUTC = sunTimes.dawn;
  const duskUTC = sunTimes.dusk;
  
  // Convert UTC times to minutes since midnight in local time
  // We need to handle the fact that dawn/dusk might cross midnight boundary
  const dawnLocalTime = new Date(dawnUTC.getTime() + localOffset);
  const duskLocalTime = new Date(duskUTC.getTime() + localOffset);
  
  // Get minutes since midnight for each (using UTC methods since we applied offset)
  let dawnMinutes = dawnLocalTime.getUTCHours() * 60 + dawnLocalTime.getUTCMinutes();
  let duskMinutes = duskLocalTime.getUTCHours() * 60 + duskLocalTime.getUTCMinutes();
  
  // If dusk is before dawn in minutes (crossed midnight), adjust dusk
  if (duskMinutes < dawnMinutes) {
    duskMinutes += 24 * 60; // Add 24 hours worth of minutes
  }
  
  // Log current solar schedule for debugging
  const dawnTime = `${Math.floor(dawnMinutes/60)%24}:${String(dawnMinutes%60).padStart(2, '0')}`;
  const duskTime = `${Math.floor(duskMinutes/60)%24}:${String(duskMinutes%60).padStart(2, '0')} ${duskMinutes > 24*60 ? '(+1d)' : ''}`;
  
  // Check if we're in one of the polling windows
  
  // 1. Every 30 mins from 30 mins after dawn to 30 mins after dusk
  const activeStart = dawnMinutes + 30;  // Start 30 mins after dawn
  const activeEnd = duskMinutes + 30;    // End 30 mins after dusk
  
  if (localTimeMinutes >= activeStart && localTimeMinutes <= activeEnd) {
    // During active hours, poll on :00 and :30
    if ((localMinutes === 0 || localMinutes === 30) && minutesSinceLastPoll >= 25) {
      console.log(`[ENPHASE] Polling during active solar hours (dawn ${dawnTime}, dusk ${duskTime})`);
      return true;
    }
    // Not on a polling minute during active hours
    if (localMinutes !== 0 && localMinutes !== 30) {
      console.log(`[ENPHASE] Skipping - active hours but not at :00 or :30 (current :${String(localMinutes).padStart(2, '0')})`);
    }
    return false;
  }
  
  // 2. Hourly polls between 01:00-05:00 to check yesterday's data completeness
  // Poll on the hour (:00) during these hours
  if (localHour >= 1 && localHour <= 5 && localMinutes === 0) {
    console.log(`[ENPHASE] ${localHour}:00 check for yesterday's data completeness`);
    return true;
  }
  
  // 3. Outside active hours - provide informative message
  if (localTimeMinutes < activeStart) {
    const minutesUntilActive = activeStart - localTimeMinutes;
    console.log(`[ENPHASE] Skipping - ${minutesUntilActive} minutes before sunrise+30min (dawn at ${dawnTime})`);
  } else if (localTimeMinutes > activeEnd) {
    const minutesSinceSunset = localTimeMinutes - activeEnd;
    console.log(`[ENPHASE] Skipping - ${minutesSinceSunset} minutes after sunset+30min (dusk at ${duskTime})`);
  }
  
  return false;
}

/**
 * Poll all Enphase systems that are due for polling
 * @param testSystemId - Optional system ID to test (development only)
 * @param forceTest - Force polling regardless of schedule (development only)
 * @param testDate - Optional CalendarDate to fetch (development only)
 */
export async function pollEnphaseSystems(
  testSystemId?: number,
  forceTest: boolean = false,
  testDate?: CalendarDate
): Promise<{
  polled: number;
  skipped: number;
  errors: number;
}> {
  console.log('[ENPHASE] Starting polling check');
  
  // Get all active Enphase systems (or just the test system)
  let enphaseSystems;
  if (testSystemId !== undefined) {
    console.log(`[ENPHASE] Testing single system: ${testSystemId} (force=${forceTest})`);
    enphaseSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.id, testSystemId));
  } else {
    enphaseSystems = await db
      .select()
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, 'enphase'),
          eq(systems.status, 'active')
        )
      );
  }
  
  console.log(`[ENPHASE] Found ${enphaseSystems.length} active systems`);
  
  let polledCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  for (const system of enphaseSystems) {
    try {
      // Validate system has owner - this should never happen but fail loudly if it does
      if (!system.ownerClerkUserId) {
        throw new Error(`System ${system.id} has no owner configured - this should not be possible for active systems`);
      }
      
      // Get last poll time
      const [status] = await db
        .select()
        .from(pollingStatus)
        .where(eq(pollingStatus.systemId, system.id))
        .limit(1);
      
      const lastPollTime = status?.lastPollTime || null;
      
      // Cast to validated type - we know ownerClerkUserId is not null now
      const validatedSystem = system as typeof system & { ownerClerkUserId: string };
      
      // Check if we should poll (skip this check if force flag is set)
      if (!forceTest && !shouldPollEnphaseNow(validatedSystem, lastPollTime)) {
        skippedCount++;
        continue;
      }
      
      if (forceTest) {
        console.log(`[ENPHASE] Force polling system ${system.id} (ignoring schedule)`);
      }
      
      console.log(`[ENPHASE] Polling system ${system.id} (${system.displayName})`);
      
      // Check if we're in the 01:00-05:00 window for yesterday's data check
      const localTime = getZonedNow(system.timezoneOffsetMin);
      const localHour = localTime.hour;
      
      let result;
      const startTime = Date.now();
      
      if (testDate) {
        // If a specific date is provided, fetch that date
        console.log(`[ENPHASE] Fetching data for ${testDate.year}-${testDate.month}-${testDate.day} for system ${system.id}`);
        result = await fetchEnphase5MinDay(system.id, testDate, system.timezoneOffsetMin, false);
      } else if (localHour >= 1 && localHour <= 5) {
        // During 01:00-05:00, check and fetch yesterday's data if incomplete
        console.log(`[ENPHASE] Checking yesterday's data completeness for system ${system.id}`);
        result = await checkAndFetchYesterdayIfNeeded(system.id, false);
      } else {
        // Otherwise fetch current day's data
        result = await fetchEnphaseCurrentDay(system.id, false);
      }
      
      const duration = Date.now() - startTime;
      
      if ('fetched' in result && !result.fetched) {
        console.log(`[ENPHASE] System ${system.id}: Yesterday's data already complete, skipped fetch`);
      } else if ('upsertedCount' in result) {
        console.log(`[ENPHASE] System ${system.id}: Upserted ${result.upsertedCount} records in ${duration}ms`);
      }
      
      // Update polling status (without storing full response)
      const now = new Date();
      
      if (status) {
        // Update existing status
        await db
          .update(pollingStatus)
          .set({
            lastPollTime: now,
            lastSuccessTime: now,
            lastError: null,
            lastResponse: null, // Don't store full response
            consecutiveErrors: 0,
            totalPolls: (status.totalPolls || 0) + 1,
            successfulPolls: (status.successfulPolls || 0) + 1,
            updatedAt: now
          })
          .where(eq(pollingStatus.systemId, system.id));
      } else {
        // Create new status
        await db
          .insert(pollingStatus)
          .values({
            systemId: system.id,
            lastPollTime: now,
            lastSuccessTime: now,
            lastError: null,
            lastResponse: null, // Don't store full response
            consecutiveErrors: 0,
            totalPolls: 1,
            successfulPolls: 1,
            updatedAt: now
          });
      }
      
      polledCount++;
      
    } catch (error) {
      console.error(`[ENPHASE] Error polling system ${system.id}:`, error);
      errorCount++;
      
      // Update error status
      const now = new Date();
      const [status] = await db
        .select()
        .from(pollingStatus)
        .where(eq(pollingStatus.systemId, system.id))
        .limit(1);
      
      if (status) {
        await db
          .update(pollingStatus)
          .set({
            lastPollTime: now,
            lastErrorTime: now,
            lastError: error instanceof Error ? error.message : 'Unknown error',
            lastResponse: null, // Don't store full response
            consecutiveErrors: (status.consecutiveErrors || 0) + 1,
            totalPolls: (status.totalPolls || 0) + 1,
            updatedAt: now
          })
          .where(eq(pollingStatus.systemId, system.id));
      } else {
        await db
          .insert(pollingStatus)
          .values({
            systemId: system.id,
            lastPollTime: now,
            lastErrorTime: now,
            lastError: error instanceof Error ? error.message : 'Unknown error',
            lastResponse: null,
            consecutiveErrors: 1,
            totalPolls: 1,
            successfulPolls: 0,
            updatedAt: now
          });
      }
    }
  }
  
  console.log(`[ENPHASE] Complete - Polled: ${polledCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
  
  return {
    polled: polledCount,
    skipped: skippedCount,
    errors: errorCount
  };
}

/**
 * Check if we're in a valid polling minute (called every minute by cron)
 * Returns true if any Enphase system might need polling
 */
export function isEnphasePollingMinute(): boolean {
  const now = new Date();
  const minutes = now.getMinutes();
  
  // Poll on :00 and :30 for active hours, :00 for midnight
  return minutes === 0 || minutes === 30;
}