import { fetchEnphaseCurrentDay, checkAndFetchYesterdayIfNeeded, fetchEnphase5MinDay } from './enphase-history';
import { checkEnphasePollingSchedule } from './enphase-cron';
import { getZonedNow } from '@/lib/date-utils';
import { CalendarDate } from '@internationalized/date';
import { 
  getPollingStatus, 
  updatePollingStatusSuccess, 
  updatePollingStatusError,
  validateSystemForPolling,
  type PollingResult 
} from '@/lib/polling-utils';

/**
 * Poll a single Enphase system
 */
export async function pollEnphaseSystem(
  system: any, // System object must be passed in
  options: {
    force?: boolean;
    date?: CalendarDate;
  } = {}
): Promise<PollingResult> {
  const startTime = Date.now();
  
  try {
    // Validate system
    const validationError = validateSystemForPolling(system, 'enphase');
    if (validationError) {
      return validationError;
    }
    
    const systemId = system.id;
    
    // Check if we should poll
    if (!options.force) {
      const status = await getPollingStatus(systemId);
      const lastPollTime = status?.lastPollTime || null;
      
      // Type assertion since we know ownerClerkUserId is not null
      const validatedSystem = system as typeof system & { ownerClerkUserId: string };
      
      const scheduleCheck = checkEnphasePollingSchedule(validatedSystem, lastPollTime);
      if (!scheduleCheck.shouldPollNow) {
        return {
          systemId,
          displayName: system.displayName || undefined,
          vendorType: 'enphase',
          status: 'skipped',
          skipReason: scheduleCheck.skipReason || 'Outside polling schedule'
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
    console.error(`[ENPHASE] Error polling system ${system.id}:`, error);
    
    // Update error status
    await updatePollingStatusError(system.id, error instanceof Error ? error : 'Unknown error');
    
    return {
      systemId: system.id,
      vendorType: 'enphase',
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: Date.now() - startTime
    };
  }
}