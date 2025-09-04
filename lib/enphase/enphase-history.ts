import { db } from '@/lib/db';
import { readingsAgg5m, systems } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getEnphaseClient } from './enphase-client';
import { CalendarDate } from '@internationalized/date';
import { calendarDateToUnixRange, getYesterdayInTimezone, getTodayInTimezone, getZonedNow, fromUnixTimestamp, formatTimeAEST } from '@/lib/date-utils';

interface EnphaseHistoryOptions {
  systemId: number;
  startTime: Date;
  endTime: Date;
  dryRun?: boolean;
}

interface EnphaseInterval {
  end_at: number;
  devices_reporting: number;
  powr: number;
  enwh: number;
}

interface EnphaseProductionResponse {
  system_id: number;
  granularity: string;
  total_devices: number;
  start_at: number;
  end_at: number;
  intervals: EnphaseInterval[];
}

/**
 * Get and validate a system from the database
 */
async function getValidatedEnphaseSystem(systemId: number) {
  const [system] = await db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
    
  if (!system) {
    throw new Error(`System ${systemId} not found`);
  }
  
  if (system.vendorType !== 'enphase') {
    throw new Error(`System ${systemId} is not an Enphase system (type: ${system.vendorType})`);
  }
  
  if (!system.ownerClerkUserId) {
    throw new Error(`System ${systemId} has no owner`);
  }
  
  // Type assertion since we've validated ownerClerkUserId is not null
  return system as typeof system & { ownerClerkUserId: string };
}

/**
 * Fetch historical Enphase data and insert into 5-minute aggregation table
 */
export async function fetchEnphaseHistory(options: EnphaseHistoryOptions) {
  const { systemId, startTime, endTime, dryRun = false } = options;
  
  console.log(`[ENPHASE-HISTORY] Fetching history for system ${systemId}`);
  
  // Get and validate system
  const system = await getValidatedEnphaseSystem(systemId);
  
  // Convert to Unix timestamps
  const startUnix = Math.floor(startTime.getTime() / 1000);
  const endUnix = Math.floor(endTime.getTime() / 1000);
  
  // Log the period in readable format
  const startFormatted = formatTimeAEST(fromUnixTimestamp(startUnix, system.timezoneOffsetMin));
  const endFormatted = formatTimeAEST(fromUnixTimestamp(endUnix, system.timezoneOffsetMin));
  console.log(`[ENPHASE-HISTORY] Period: ${startFormatted} to ${endFormatted}`);
  
  // Fetch the raw data
  const productionData = await fetchEnphaseProductionData(system, startUnix, endUnix);
  
  console.log(`[ENPHASE-HISTORY] Found ${productionData.intervals.length} intervals`);
  
  // Process the data into records
  const records = processEnphaseData(productionData, systemId, startUnix, endUnix);
  
  // Check for existing data to avoid duplicates (for insert-only mode)
  const existingData = await db
    .select()
    .from(readingsAgg5m)
    .where(
      and(
        eq(readingsAgg5m.systemId, systemId),
        gte(readingsAgg5m.intervalEnd, startUnix),
        lte(readingsAgg5m.intervalEnd, endUnix)
      )
    );
  
  const existingIntervals = new Set(existingData.map(d => d.intervalEnd));
  console.log(`[ENPHASE-HISTORY] Found ${existingIntervals.size} existing intervals in database`);
  
  // Filter out existing records (skip duplicates)
  const recordsToInsert = records.filter(r => !existingIntervals.has(r.intervalEnd));
  const skippedCount = records.length - recordsToInsert.length;
  
  console.log(`[ENPHASE-HISTORY] Prepared ${recordsToInsert.length} records for insertion (${skippedCount} skipped)`);
  
  if (dryRun) {
    console.log('[ENPHASE-HISTORY] Dry run - not inserting data');
    if (recordsToInsert.length > 0) {
      console.log('[ENPHASE-HISTORY] Sample record:', JSON.stringify(recordsToInsert[0], null, 2));
    }
    return {
      intervalCount: productionData.intervals.length,
      insertedCount: 0,
      skippedCount,
      errorCount: 0,
      dryRun: true,
      sampleRecord: recordsToInsert[0]
    };
  }
  
  // Insert records (not upsert since we filtered existing)
  const batchSize = 100;
  let insertedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < recordsToInsert.length; i += batchSize) {
    const batch = recordsToInsert.slice(i, i + batchSize);
    
    try {
      await db.insert(readingsAgg5m).values(batch);
      insertedCount += batch.length;
      console.log(`[ENPHASE-HISTORY] Inserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(recordsToInsert.length / batchSize)} (${batch.length} records)`);
    } catch (error) {
      console.error(`[ENPHASE-HISTORY] Error inserting batch:`, error);
      errorCount += batch.length;
    }
  }
  
  console.log(`[ENPHASE-HISTORY] Complete - Inserted: ${insertedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
  
  return {
    intervalCount: productionData.intervals.length,
    insertedCount,
    skippedCount,
    errorCount
  };
}

/**
 * Convenience function to fetch last N hours of history
 */
export async function fetchRecentEnphaseHistory(systemId: number, hours: number, dryRun = false) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
  
  return fetchEnphaseHistory({
    systemId,
    startTime,
    endTime,
    dryRun
  });
}

/**
 * Fetch history for a specific date
 */
export async function fetchEnphaseHistoryForDate(systemId: number, date: Date, dryRun = false) {
  // Set to start of day in system's local time
  const startTime = new Date(date);
  startTime.setHours(0, 0, 0, 0);
  
  const endTime = new Date(date);
  endTime.setHours(23, 59, 59, 999);
  
  return fetchEnphaseHistory({
    systemId,
    startTime,
    endTime,
    dryRun
  });
}

/**
 * Fetch raw production data from Enphase API for a specific time range
 * @param system - The system record from database
 * @param startUnix - Start timestamp in Unix seconds
 * @param endUnix - End timestamp in Unix seconds (optional)
 * @returns Raw Enphase production response
 */
async function fetchEnphaseProductionData(
  system: { id: number; vendorSiteId: string; ownerClerkUserId: string },
  startUnix?: number,
  endUnix?: number
): Promise<EnphaseProductionResponse> {
  // Determine if we're in development mode
  const isDev = process.env.NODE_ENV === 'development' || !process.env.TURSO_DATABASE_URL;
  
  if (isDev) {
    // In development, proxy through production
    console.log('[ENPHASE-HISTORY] Development mode - proxying through production');
    
    const prodUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://liveone.vercel.app';
    
    let url: string;
    
    if (startUnix) {
      // Build URL with parameters for historical data
      const params = new URLSearchParams({
        start_at: startUnix.toString(),
        granularity: 'day'  // This returns 5-minute data for the full day
      });
      if (endUnix) {
        params.append('end_at', endUnix.toString());
      }
      url = `/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro?${params}`;
      console.log(`[ENPHASE-HISTORY] Fetching historical data with params: ${params}`);
    } else {
      // No parameters - gets today's partial data
      url = `/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
      console.log(`[ENPHASE-HISTORY] Fetching today's partial data (no parameters)`);
    }
    
    console.log(`[ENPHASE-HISTORY] Enphase API URL: ${url}`);
    
    const fullProxyUrl = `${prodUrl}/api/enphase-proxy?systemId=${system.id}&url=${encodeURIComponent(url)}`;
    console.log(`[ENPHASE-HISTORY] Full proxy URL: ${fullProxyUrl}`);
    
    const response = await fetch(fullProxyUrl);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch from production proxy: ${error}`);
    }
    
    const proxyResponse = await response.json();
    
    if (proxyResponse.response?.status !== 200) {
      throw new Error(`Enphase API error: ${JSON.stringify(proxyResponse.response)}`);
    }
    
    return proxyResponse.response.data;
    
  } else {
    // In production, go directly to Enphase
    console.log('[ENPHASE-HISTORY] Production mode - direct Enphase API call');
    
    const client = getEnphaseClient();
    const credentials = await client.getStoredTokens(system.ownerClerkUserId);
    
    if (!credentials) {
      throw new Error(`No Enphase credentials found for user ${system.ownerClerkUserId}`);
    }
    
    // Check if token needs refresh
    let accessToken = credentials.access_token;
    if (credentials.expires_at < Date.now() + 3600000) {
      console.log('[ENPHASE-HISTORY] Refreshing token...');
      const newTokens = await client.refreshTokens(credentials.refresh_token);
      await client.storeTokens(
        system.ownerClerkUserId,
        newTokens,
        credentials.enphase_system_id
      );
      accessToken = newTokens.access_token;
    }
    
    // Build URL with or without parameters
    let url: string;
    
    if (startUnix) {
      // Build URL with parameters for historical data
      const params = new URLSearchParams({
        start_at: startUnix.toString(),
        granularity: 'day'  // This returns 5-minute data for the full day
      });
      if (endUnix) {
        params.append('end_at', endUnix.toString());
      }
      url = `https://api.enphaseenergy.com/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro?${params}`;
    } else {
      // No parameters - gets today's partial data
      url = `https://api.enphaseenergy.com/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
    }
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'key': process.env.ENPHASE_API_KEY || ''
      }
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Enphase API error: ${response.status} - ${error}`);
    }
    
    return await response.json();
  }
}

/**
 * Process Enphase production data and prepare records for database
 * @param productionData - Raw Enphase production response
 * @param systemId - System ID for the records
 * @param startUnix - Start of time range (optional, for filtering)
 * @param endUnix - End of time range (optional, for filtering)
 * @returns Array of records ready for database insertion
 */
function processEnphaseData(
  productionData: EnphaseProductionResponse,
  systemId: number,
  startUnix?: number,
  endUnix?: number
) {
  const records = [];
  
  for (const interval of productionData.intervals) {
    // Filter by time range if provided
    // Note: end_at represents the END of the interval, so:
    // - An interval ending at 00:00 belongs to the previous day (23:55-00:00)
    // - We should include intervals where end_at <= endUnix (not < endUnix)
    if (startUnix && interval.end_at < startUnix) continue;
    if (endUnix && interval.end_at > endUnix) continue;
    
    records.push({
      systemId: systemId,
      intervalEnd: interval.end_at,
      
      // For Enphase, we only have production (solar) data
      solarWAvg: interval.powr,
      solarWMin: interval.powr,
      solarWMax: interval.powr,
      
      // No load, battery, or grid data from this endpoint
      loadWAvg: null,
      loadWMin: null,
      loadWMax: null,
      
      batteryWAvg: null,
      batteryWMin: null,
      batteryWMax: null,
      
      gridWAvg: null,
      gridWMin: null,
      gridWMax: null,
      
      batterySOCLast: null,
      
      // Energy counters - convert Wh to kWh
      solarKwhTotalLast: interval.enwh ? interval.enwh / 1000 : null,
      loadKwhTotalLast: null,
      batteryInKwhTotalLast: null,
      batteryOutKwhTotalLast: null,
      gridInKwhTotalLast: null,
      gridOutKwhTotalLast: null,
      
      sampleCount: 1,
      createdAt: new Date()
    });
  }
  
  return records;
}

/**
 * Upsert records to the database in batches
 * @param records - Records to upsert
 * @param dryRun - If true, don't actually insert/update data
 * @returns Counts of upserted and error records
 */
async function upsertEnphaseRecords(records: any[], dryRun: boolean) {
  if (dryRun) {
    console.log('[ENPHASE-HISTORY] Dry run - not upserting data');
    if (records.length > 0) {
      console.log('[ENPHASE-HISTORY] Sample record:', JSON.stringify(records[0], null, 2));
    }
    return { upsertedCount: 0, errorCount: 0 };
  }
  
  // Upsert records in batches
  const batchSize = 50;
  let upsertedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    
    try {
      // Upsert each record individually to handle conflicts properly
      for (const record of batch) {
        await db.insert(readingsAgg5m)
          .values(record)
          .onConflictDoUpdate({
            target: [readingsAgg5m.systemId, readingsAgg5m.intervalEnd],
            set: {
              solarWAvg: record.solarWAvg,
              solarWMin: record.solarWMin,
              solarWMax: record.solarWMax,
              solarKwhTotalLast: record.solarKwhTotalLast,
              sampleCount: record.sampleCount,
              createdAt: record.createdAt
            }
          });
        upsertedCount++;
      }
      
      console.log(`[ENPHASE-HISTORY] Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (${batch.length} records)`);
    } catch (error) {
      console.error(`[ENPHASE-HISTORY] Error upserting batch:`, error);
      errorCount += batch.length;
    }
  }
  
  return { upsertedCount, errorCount };
}

/**
 * Fetch 5-minute data for a specific calendar day
 * @param systemId - The system ID in the database
 * @param date - The calendar date to fetch
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @param dryRun - If true, don't actually insert/update data
 * @returns Result object with counts
 */
export async function fetchEnphase5MinDay(
  systemId: number,
  date: CalendarDate,
  timezoneOffsetMin: number,
  dryRun = false
) {
  console.log(`[ENPHASE-HISTORY] Fetching 5-minute data for ${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} for system ${systemId}`);
  
  // Get and validate system
  const system = await getValidatedEnphaseSystem(systemId);
  
  // Convert calendar date to Unix timestamp range for the timezone
  const [startUnix, endUnix] = calendarDateToUnixRange(date, timezoneOffsetMin);
  
  // Format times for logging
  const startTime = formatTimeAEST(fromUnixTimestamp(startUnix, timezoneOffsetMin));
  const endTime = formatTimeAEST(fromUnixTimestamp(endUnix, timezoneOffsetMin));
  console.log(`[ENPHASE-HISTORY] Fetching data from ${startTime} to ${endTime}`);
  
  // Fetch the raw data
  const productionData = await fetchEnphaseProductionData(system, startUnix, endUnix);
  
  console.log(`[ENPHASE-HISTORY] Received ${productionData.intervals.length} intervals`);
  
  // Process the data into records
  const records = processEnphaseData(productionData, systemId, startUnix, endUnix);
  
  console.log(`[ENPHASE-HISTORY] Prepared ${records.length} records for upsert`);
  
  // Upsert to database
  const { upsertedCount, errorCount } = await upsertEnphaseRecords(records, dryRun);
  
  console.log(`[ENPHASE-HISTORY] Complete - Upserted: ${upsertedCount}, Errors: ${errorCount}`);
  
  return {
    intervalCount: records.length,
    upsertedCount,
    errorCount,
    dryRun
  };
}

/**
 * Convenience function to fetch yesterday's 5-minute data
 * @param systemId - The system ID in the database
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @param dryRun - If true, don't actually insert/update data
 */
export async function fetchEnphaseYesterday5Min(
  systemId: number,
  timezoneOffsetMin: number,
  dryRun = false
) {
  const yesterday = getYesterdayInTimezone(timezoneOffsetMin);
  console.log(`[ENPHASE-HISTORY] Fetching yesterday's data (${yesterday.year}-${String(yesterday.month).padStart(2, '0')}-${String(yesterday.day).padStart(2, '0')}) for system ${systemId}`);
  
  return fetchEnphase5MinDay(systemId, yesterday, timezoneOffsetMin, dryRun);
}

/**
 * Fetch the current day's partial data and upsert into database
 * This fetches today's partial data (up to current time) using the API without parameters
 */
export async function fetchEnphaseCurrentDay(systemId: number, dryRun = false) {
  console.log(`[ENPHASE-HISTORY] Fetching current day's data for system ${systemId}`);
  
  // Get and validate system  
  const system = await getValidatedEnphaseSystem(systemId);
  
  // Get the current date in the system's timezone
  const today = getTodayInTimezone(system.timezoneOffsetMin);
  console.log(`[ENPHASE-HISTORY] Fetching today's partial data (${today.year}-${today.month}-${today.day})`);
  
  // Fetch without parameters to get today's partial data
  const productionData = await fetchEnphaseProductionData(system);
  
  if (!productionData || !productionData.intervals || productionData.intervals.length === 0) {
    console.log(`[ENPHASE-HISTORY] No data returned for today`);
    return {
      upsertedCount: 0,
      errorCount: 0
    };
  }
  
  console.log(`[ENPHASE-HISTORY] Received ${productionData.intervals.length} intervals for today`);
  
  // Process the data without date filtering (all data is for today)
  const records = processEnphaseData(productionData, systemId);
  
  console.log(`[ENPHASE-HISTORY] Prepared ${records.length} records for upsert`);
  
  if (dryRun) {
    console.log('[ENPHASE-HISTORY] Dry run - skipping database upsert');
    return {
      upsertedCount: records.length,
      errorCount: 0
    };
  }
  
  // Upsert the records
  return await upsertEnphaseRecords(records, dryRun);
}

/**
 * Check if we have sufficient evening data for a specific day (18:00-23:55)
 * @param systemId - System ID
 * @param date - Calendar date to check
 * @param timezoneOffsetMin - Timezone offset in minutes
 * @returns true if we have at least 80% of evening intervals
 */
export async function hasCompleteEveningData(
  systemId: number,
  date: CalendarDate,
  timezoneOffsetMin: number
): Promise<boolean> {
  // Get Unix timestamps for the day in the system's timezone
  const [dayStartUnix, dayEndUnix] = calendarDateToUnixRange(date, timezoneOffsetMin);
  
  // Calculate 18:00 and 23:55 (inclusive) - these are 5-minute interval END times
  // 18:00 interval ends at 18:00:00
  // 23:55 interval ends at 23:55:00  
  const eveningStartUnix = dayStartUnix + (18 * 3600); // 18:00 (6pm)
  const eveningEndUnix = dayEndUnix - 300;              // 23:55 (5 minutes before midnight)
  
  // Query for existing data in this range
  const existingData = await db
    .select()
    .from(readingsAgg5m)
    .where(
      and(
        eq(readingsAgg5m.systemId, systemId),
        gte(readingsAgg5m.intervalEnd, eveningStartUnix),
        lte(readingsAgg5m.intervalEnd, eveningEndUnix)
      )
    );
  
  // We expect 72 intervals from 18:00 to 23:55 (6 hours * 12 intervals per hour)
  const expectedIntervals = 72;
  const percentComplete = Math.round((existingData.length / expectedIntervals) * 100);
  const hasEnoughData = percentComplete >= 80; // Need at least 80% complete
  
  console.log(`[ENPHASE-HISTORY] Yesterday evening data is ${percentComplete}% complete (${existingData.length}/${expectedIntervals} intervals)`);
  
  return hasEnoughData;
}

/**
 * Check and fetch yesterday's data if incomplete
 * Called hourly between 01:00-05:00 in the system's timezone
 */
export async function checkAndFetchYesterdayIfNeeded(systemId: number, dryRun = false) {
  console.log(`[ENPHASE-HISTORY] Checking if yesterday's data is complete for system ${systemId}`);
  
  // Get and validate system
  const system = await getValidatedEnphaseSystem(systemId);
  
  // Get yesterday's date in the system's timezone
  const yesterday = getYesterdayInTimezone(system.timezoneOffsetMin);
  
  // Check if we have complete evening data
  const hasData = await hasCompleteEveningData(systemId, yesterday, system.timezoneOffsetMin);
  
  if (hasData) {
    console.log(`[ENPHASE-HISTORY] Yesterday's data is sufficiently complete, skipping fetch`);
    return {
      fetched: false,
      reason: 'Data already complete'
    };
  }
  
  console.log(`[ENPHASE-HISTORY] Yesterday's data needs updating, fetching full day`);
  const result = await fetchEnphase5MinDay(systemId, yesterday, system.timezoneOffsetMin, dryRun);
  
  return {
    fetched: true,
    ...result
  };
}