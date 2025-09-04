import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { fetchEnphaseCurrentDay, checkAndFetchYesterdayIfNeeded, fetchEnphase5MinDay } from './enphase-history';
import { shouldPollEnphaseNow } from './enphase-cron';
import { getZonedNow } from '@/lib/date-utils';
import { CalendarDate } from '@internationalized/date';
import { 
  getPollingStatus, 
  updatePollingStatusSuccess, 
  updatePollingStatusError,
  type PollingResult 
} from '@/lib/polling-utils';

/**
 * Poll a single Enphase system
 */
export async function pollEnphaseSystem(
  systemId: number,
  options: {
    force?: boolean;
    date?: CalendarDate;
  } = {}
): Promise<PollingResult> {
  const startTime = Date.now();
  
  try {
    // Get system details
    const [system] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1);
    
    if (!system) {
      return {
        systemId,
        status: 'error',
        error: 'System not found'
      };
    }
    
    if (system.vendorType !== 'enphase') {
      return {
        systemId,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
        status: 'error',
        error: `Not an Enphase system (type: ${system.vendorType})`
      };
    }
    
    if (!system.ownerClerkUserId) {
      return {
        systemId,
        displayName: system.displayName || undefined,
        vendorType: 'enphase',
        status: 'error',
        error: 'No owner configured'
      };
    }
    
    // Check if we should poll
    if (!options.force) {
      const status = await getPollingStatus(systemId);
      const lastPollTime = status?.lastPollTime || null;
      
      // Type assertion since we know ownerClerkUserId is not null
      const validatedSystem = system as typeof system & { ownerClerkUserId: string };
      
      if (!shouldPollEnphaseNow(validatedSystem, lastPollTime)) {
        // Get skip reason for better reporting
        const now = new Date();
        const minutesSinceLastPoll = lastPollTime 
          ? Math.floor((now.getTime() - lastPollTime.getTime()) / 60000)
          : null;
        
        let skipReason = 'Outside polling schedule';
        if (minutesSinceLastPoll !== null && minutesSinceLastPoll < 25) {
          skipReason = `Polled ${minutesSinceLastPoll} minutes ago (min 25)`;
        }
        
        return {
          systemId,
          displayName: system.displayName || undefined,
          vendorType: 'enphase',
          status: 'skipped',
          skipReason
        };
      }
    }
    
    if (options.force) {
      console.log(`[ENPHASE] Force polling system ${system.id} (ignoring schedule)`);
    }
    
    console.log(`[ENPHASE] Polling system ${system.id} (${system.displayName})`);
    
    // Determine what to fetch
    let result;
    
    if (options.date) {
      // If a specific date is provided, fetch that date
      console.log(`[ENPHASE] Fetching data for ${options.date.year}-${options.date.month}-${options.date.day} for system ${system.id}`);
      result = await fetchEnphase5MinDay(system.id, options.date, system.timezoneOffsetMin, false);
    } else {
      const localTime = getZonedNow(system.timezoneOffsetMin);
      const localHour = localTime.hour;
      
      if (localHour >= 1 && localHour <= 5) {
        // During 01:00-05:00, check and fetch yesterday's data if incomplete
        console.log(`[ENPHASE] Checking yesterday's data completeness for system ${system.id}`);
        result = await checkAndFetchYesterdayIfNeeded(system.id, false);
      } else {
        // Otherwise fetch current day's data
        result = await fetchEnphaseCurrentDay(system.id, false);
      }
    }
    
    const duration = Date.now() - startTime;
    
    // Update polling status (don't store full Enphase response to save space)
    await updatePollingStatusSuccess(systemId, null);
    
    // Determine records upserted
    let recordsUpserted = 0;
    if ('upsertedCount' in result) {
      recordsUpserted = result.upsertedCount;
    } else if ('fetched' in result && !result.fetched) {
      // Yesterday's data was already complete
      recordsUpserted = 0;
    }
    
    console.log(`[ENPHASE] System ${system.id}: Upserted ${recordsUpserted} records in ${duration}ms`);
    
    return {
      systemId,
      displayName: system.displayName || undefined,
      vendorType: 'enphase',
      status: 'polled',
      recordsUpserted,
      durationMs: duration
    };
    
  } catch (error) {
    console.error(`[ENPHASE] Error polling system ${systemId}:`, error);
    
    // Update error status
    await updatePollingStatusError(systemId, error instanceof Error ? error : 'Unknown error');
    
    return {
      systemId,
      vendorType: 'enphase',
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: Date.now() - startTime
    };
  }
}