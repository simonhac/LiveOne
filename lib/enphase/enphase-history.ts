import { db } from '@/lib/db';
import { readingsAgg5m, systems } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getEnphaseClient } from './enphase-client';
import { CalendarDate } from '@internationalized/date';
import { calendarDateToUnixRange, getYesterdayInTimezone, getTodayInTimezone, getZonedNow, fromUnixTimestamp, formatTimeAEST } from '@/lib/date-utils';


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
 * Fetch wrapper that handles Enphase API authentication and proxies through production in development
 */
async function fetchEnphase(
  system: { id: number; ownerClerkUserId: string },
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const isDev = process.env.NODE_ENV === 'development' || !process.env.TURSO_DATABASE_URL;
  
  if (isDev) {
    // In development, proxy through production
    const urlString = url.toString();
    // Remove the base URL if present
    const apiPath = urlString.replace('https://api.enphaseenergy.com', '');
    
    const prodUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://liveone.vercel.app';
    const proxyUrl = `${prodUrl}/api/enphase-proxy?systemId=${system.id}&url=${encodeURIComponent(apiPath)}`;
    
    // Proxying through production
    
    const response = await fetch(proxyUrl);
    
    if (!response.ok) {
      // Return the response as-is to let caller handle it
      return response;
    }
    
    const proxyResponse = await response.json();
    
    // Create a Response object from the proxy response
    return new Response(JSON.stringify(proxyResponse.response.data), {
      status: proxyResponse.response.status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // In production, get auth tokens and make direct request
  // Production mode - getting auth tokens
  
  const client = getEnphaseClient();
  const credentials = await client.getStoredTokens(system.ownerClerkUserId);
  
  if (!credentials) {
    throw new Error(`No Enphase credentials found for user ${system.ownerClerkUserId}`);
  }
  
  // Check if token needs refresh (expires_at is now a Date object)
  let accessToken = credentials.access_token;
  const oneHourFromNow = new Date(Date.now() + 3600000);
  if (credentials.expires_at < oneHourFromNow) {
    // Refreshing token
    const newTokens = await client.refreshTokens(credentials.refresh_token);
    await client.storeTokens(
      system.ownerClerkUserId,
      newTokens,
      credentials.enphase_system_id
    );
    accessToken = newTokens.access_token;
  }
  
  // Add auth headers to the request
  const headers = {
    ...init?.headers,
    'Authorization': `Bearer ${accessToken}`,
    'key': process.env.ENPHASE_API_KEY || ''
  };
  
  return fetch(url, { ...init, headers });
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
  // Build base URL
  let url = `https://api.enphaseenergy.com/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
  
  // Add parameters if fetching historical data
  if (startUnix) {
    const params = new URLSearchParams({
      start_at: startUnix.toString(),
      granularity: 'day'  // This returns 5-minute data for the full day
    });
    if (endUnix) {
      params.append('end_at', endUnix.toString());
    }
    url += `?${params}`;
    console.log(`[Enphase] Fetching historical data with params: ${params}`);
  } else {
    console.log(`[Enphase] Fetching today's partial data (no parameters)`);
  }
  
  console.log(`[Enphase] Fetching data from ${url}`);
  const response = await fetchEnphase(system, url);
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Enphase API error: ${response.status} - ${error}`);
  }
  
  return await response.json();
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
      solarIntervalWh: interval.enwh, // Energy produced in this 5-minute interval
      
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
    console.log('[Enphase] Dry run - not upserting data');
    if (records.length > 0) {
      console.log('[Enphase] Sample record:', JSON.stringify(records[0], null, 2));
    }
    return { upsertedCount: 0, errorCount: 0 };
  }
  
  // Upsert records in batches
  const batchSize = 300;
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
              solarIntervalWh: record.solarIntervalWh,
              solarKwhTotalLast: record.solarKwhTotalLast,
              sampleCount: record.sampleCount,
              createdAt: record.createdAt
            }
          });
        upsertedCount++;
      }
      
      console.log(`[Enphase] Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (${batch.length} records)`);
    } catch (error) {
      console.error(`[Enphase] Error upserting batch:`, error);
      errorCount += batch.length;
    }
  }
  
  return { upsertedCount, errorCount };
}

/**
 * Fetch 5-minute data for a specific calendar day (today or historical)
 * @param systemId - The system ID in the database
 * @param date - The calendar date to fetch (null means today)
 * @param timezoneOffsetMin - Timezone offset in minutes from UTC
 * @param dryRun - If true, don't actually insert/update data
 * @returns Result object with counts
 */
export async function fetchEnphaseDay(
  systemId: number,
  date: CalendarDate | null,
  timezoneOffsetMin: number,
  dryRun = false
) {
  // Get and validate system
  const system = await getValidatedEnphaseSystem(systemId);
  
  // Check if we're fetching today
  const today = getTodayInTimezone(timezoneOffsetMin);
  const actualDate = date || today;
  const isToday = actualDate.compare(today) === 0;
  const dateLabel = isToday ? "today" : actualDate.toString();
  
  console.log(`[Enphase] Fetching 5-minute data for ${dateLabel} for system ${systemId} (${system.displayName})`);
  
  let productionData: EnphaseProductionResponse;
  let startUnix: number | undefined;
  let endUnix: number | undefined;
  
  if (isToday) {
    console.log(`[Enphase] Fetching today's partial data`);
    // For today, don't pass timestamps to get partial data
    productionData = await fetchEnphaseProductionData(system);
  } else {
    // For historical dates, use the full day range
    [startUnix, endUnix] = calendarDateToUnixRange(actualDate, timezoneOffsetMin);
    
    // Format times for logging
    const startTime = formatTimeAEST(fromUnixTimestamp(startUnix, timezoneOffsetMin));
    const endTime = formatTimeAEST(fromUnixTimestamp(endUnix, timezoneOffsetMin));
    console.log(`[Enphase] Fetching data from ${startTime} to ${endTime}`);
    
    // Fetch the raw data
    productionData = await fetchEnphaseProductionData(system, startUnix, endUnix);
  }
  
  // Check if we got data
  if (!productionData || !productionData.intervals || productionData.intervals.length === 0) {
    console.log(`[Enphase] No data returned for ${dateLabel}`);
    return {
      upsertedCount: 0,
      errorCount: 0
    };
  }
  
  console.log(`[Enphase] Received ${productionData.intervals.length} intervals`);
  
  // Process the data into records
  // For today, don't pass date filters; for historical dates, use the range
  const records = isToday 
    ? processEnphaseData(productionData, systemId)
    : processEnphaseData(productionData, systemId, startUnix, endUnix);
  
  console.log(`[Enphase] Prepared ${records.length} records for upsert`);
  
  // Upsert to database
  const { upsertedCount, errorCount } = await upsertEnphaseRecords(records, dryRun);
  
  // Complete - details logged in polling.ts
  
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
  console.log(`[Enphase] Fetching yesterday's data (${yesterday.year}-${String(yesterday.month).padStart(2, '0')}-${String(yesterday.day).padStart(2, '0')}) for system ${systemId}`);
  
  return fetchEnphaseDay(systemId, yesterday, timezoneOffsetMin, dryRun);
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
  
  console.log(`[Enphase] Yesterday evening data is ${percentComplete}% complete (${existingData.length}/${expectedIntervals} intervals)`);
  
  return hasEnoughData;
}

/**
 * Check and fetch yesterday's data if incomplete
 * Called hourly between 01:00-05:00 in the system's timezone
 */
export async function checkAndFetchYesterdayIfNeeded(systemId: number, dryRun = false) {
  // Get and validate system
  const system = await getValidatedEnphaseSystem(systemId);
  
  console.log(`[Enphase] Checking if yesterday's data is complete for system ${systemId} (${system.displayName})`);
  
  // Get yesterday's date in the system's timezone
  const yesterday = getYesterdayInTimezone(system.timezoneOffsetMin);
  
  // Check if we have complete evening data
  const hasData = await hasCompleteEveningData(systemId, yesterday, system.timezoneOffsetMin);
  
  if (hasData) {
    console.log(`[Enphase] Yesterday's data is sufficiently complete, skipping fetch`);
    return {
      fetched: false,
      reason: 'Data already complete'
    };
  }
  
  console.log(`[Enphase] Yesterday's data needs updating, fetching full day`);
  const result = await fetchEnphaseDay(systemId, yesterday, system.timezoneOffsetMin, dryRun);
  
  return {
    fetched: true,
    ...result
  };
}