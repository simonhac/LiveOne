import { db } from '@/lib/db';
import { readingsAgg5m, systems } from '@/lib/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getEnphaseClient } from './enphase-client';

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
 * Fetch historical Enphase data and insert into 5-minute aggregation table
 */
export async function fetchEnphaseHistory(options: EnphaseHistoryOptions) {
  const { systemId, startTime, endTime, dryRun = false } = options;
  
  console.log(`[ENPHASE-HISTORY] Fetching history for system ${systemId}`);
  console.log(`[ENPHASE-HISTORY] Period: ${startTime.toISOString()} to ${endTime.toISOString()}`);
  
  // Get system details
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
  
  // Determine if we're in development mode
  const isDev = process.env.NODE_ENV === 'development' || !process.env.TURSO_DATABASE_URL;
  
  let productionData: EnphaseProductionResponse;
  
  if (isDev) {
    // In development, proxy through production
    console.log('[ENPHASE-HISTORY] Development mode - proxying through production');
    
    const prodUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://liveone.vercel.app';
    const url = `/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
    
    const response = await fetch(`${prodUrl}/api/enphase-proxy?systemId=${systemId}&url=${encodeURIComponent(url)}`);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch from production proxy: ${error}`);
    }
    
    const proxyResponse = await response.json();
    
    if (proxyResponse.response?.status !== 200) {
      throw new Error(`Enphase API error: ${JSON.stringify(proxyResponse.response)}`);
    }
    
    productionData = proxyResponse.response.data;
    
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
    
    // Fetch production data
    const url = `https://api.enphaseenergy.com/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
    
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
    
    productionData = await response.json();
  }
  
  // Filter intervals to requested time range
  const startTimestamp = Math.floor(startTime.getTime() / 1000);
  const endTimestamp = Math.floor(endTime.getTime() / 1000);
  
  const relevantIntervals = productionData.intervals.filter(interval => 
    interval.end_at >= startTimestamp && interval.end_at <= endTimestamp
  );
  
  console.log(`[ENPHASE-HISTORY] Found ${relevantIntervals.length} intervals in time range`);
  
  if (relevantIntervals.length === 0) {
    console.log('[ENPHASE-HISTORY] No data in requested time range');
    return { 
      intervalCount: 0, 
      insertedCount: 0,
      skippedCount: 0,
      errorCount: 0 
    };
  }
  
  // Check for existing data to avoid duplicates
  const existingData = await db
    .select()
    .from(readingsAgg5m)
    .where(
      and(
        eq(readingsAgg5m.systemId, systemId),
        gte(readingsAgg5m.intervalEnd, startTimestamp),
        lte(readingsAgg5m.intervalEnd, endTimestamp)
      )
    );
  
  const existingIntervals = new Set(existingData.map(d => d.intervalEnd));
  console.log(`[ENPHASE-HISTORY] Found ${existingIntervals.size} existing intervals in database`);
  
  // Prepare records for insertion
  const recordsToInsert = [];
  let skippedCount = 0;
  
  for (const interval of relevantIntervals) {
    // Skip if we already have data for this interval
    if (existingIntervals.has(interval.end_at)) {
      skippedCount++;
      continue;
    }
    
    // Skip intervals with no production (nighttime)
    if (interval.powr === 0 && interval.enwh === 0 && interval.devices_reporting === 0) {
      skippedCount++;
      continue;
    }
    
    recordsToInsert.push({
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
      
      sampleCount: 1, // Each interval represents one sample from Enphase
      createdAt: new Date()
    });
  }
  
  console.log(`[ENPHASE-HISTORY] Prepared ${recordsToInsert.length} records for insertion (${skippedCount} skipped)`);
  
  if (dryRun) {
    console.log('[ENPHASE-HISTORY] Dry run - not inserting data');
    console.log('[ENPHASE-HISTORY] Sample record:', JSON.stringify(recordsToInsert[0], null, 2));
    return {
      intervalCount: relevantIntervals.length,
      insertedCount: 0,
      skippedCount,
      errorCount: 0,
      dryRun: true,
      sampleRecord: recordsToInsert[0]
    };
  }
  
  // Insert records in batches
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
    intervalCount: relevantIntervals.length,
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
 * Fetch the current day's full data and upsert into database
 * This is more efficient as it fetches all available data for today and upserts
 */
export async function fetchEnphaseCurrentDay(systemId: number, dryRun = false) {
  console.log(`[ENPHASE-HISTORY] Fetching current day's data for system ${systemId}`);
  
  // Get system details
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
  
  // Determine if we're in development mode
  const isDev = process.env.NODE_ENV === 'development' || !process.env.TURSO_DATABASE_URL;
  
  let productionData: EnphaseProductionResponse;
  
  if (isDev) {
    // In development, proxy through production
    console.log('[ENPHASE-HISTORY] Development mode - proxying through production');
    
    const prodUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://liveone.vercel.app';
    const url = `/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
    
    const response = await fetch(`${prodUrl}/api/enphase-proxy?systemId=${systemId}&url=${encodeURIComponent(url)}`);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch from production proxy: ${error}`);
    }
    
    const proxyResponse = await response.json();
    
    if (proxyResponse.response?.status !== 200) {
      throw new Error(`Enphase API error: ${JSON.stringify(proxyResponse.response)}`);
    }
    
    productionData = proxyResponse.response.data;
    
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
    
    // Fetch production data - no date params gives us current day
    const url = `https://api.enphaseenergy.com/api/v4/systems/${system.vendorSiteId}/telemetry/production_micro`;
    
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
    
    productionData = await response.json();
  }
  
  console.log(`[ENPHASE-HISTORY] Received ${productionData.intervals.length} intervals`);
  console.log(`[ENPHASE-HISTORY] Time range: ${new Date(productionData.start_at * 1000).toISOString()} to ${new Date(productionData.end_at * 1000).toISOString()}`);
  
  // Check if we're getting the correct day's data
  const now = new Date();
  const dataStartDate = new Date(productionData.start_at * 1000);
  const localNow = new Date(now.getTime() + system.timezoneOffsetMin * 60 * 1000);
  const localDataStart = new Date(dataStartDate.getTime() + system.timezoneOffsetMin * 60 * 1000);
  
  // If polling at midnight, we should get yesterday's data
  if (localNow.getHours() === 0 && localNow.getMinutes() < 5) {
    const yesterday = new Date(localNow);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (localDataStart.getDate() !== yesterday.getDate()) {
      console.warn(`[ENPHASE-HISTORY] WARNING: Midnight poll returned wrong day's data!`);
      console.warn(`[ENPHASE-HISTORY] Expected data for ${yesterday.toISOString().split('T')[0]} but got ${localDataStart.toISOString().split('T')[0]}`);
    } else {
      console.log(`[ENPHASE-HISTORY] Midnight poll correctly returned yesterday's data (${yesterday.toISOString().split('T')[0]})`);
    }
  }
  
  // Create a map of existing intervals from Enphase data
  const intervalMap = new Map<number, EnphaseInterval>();
  for (const interval of productionData.intervals) {
    intervalMap.set(interval.end_at, interval);
  }
  
  // Find the time range to fill
  const startTimestamp = productionData.start_at;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  // Round down to nearest 5-minute interval
  const endTimestamp = Math.floor(currentTimestamp / 300) * 300;
  
  console.log(`[ENPHASE-HISTORY] Filling gaps from ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(endTimestamp * 1000).toISOString()}`);
  
  // Generate all 5-minute intervals from start to current time
  const recordsToUpsert = [];
  let filledGaps = 0;
  
  for (let timestamp = startTimestamp; timestamp <= endTimestamp; timestamp += 300) {
    const interval = intervalMap.get(timestamp);
    
    recordsToUpsert.push({
      systemId: systemId,
      intervalEnd: timestamp,
      
      // Use actual data if available, otherwise fill with 0
      solarWAvg: interval ? interval.powr : 0,
      solarWMin: interval ? interval.powr : 0,
      solarWMax: interval ? interval.powr : 0,
      
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
      solarKwhTotalLast: interval?.enwh ? interval.enwh / 1000 : null,
      loadKwhTotalLast: null,
      batteryInKwhTotalLast: null,
      batteryOutKwhTotalLast: null,
      gridInKwhTotalLast: null,
      gridOutKwhTotalLast: null,
      
      sampleCount: 1, // Each interval represents one sample (real or filled)
      createdAt: new Date()
    });
    
    if (!interval) {
      filledGaps++;
    }
  }
  
  console.log(`[ENPHASE-HISTORY] Prepared ${recordsToUpsert.length} records for upsert (${filledGaps} gaps filled with 0)`);
  
  if (dryRun) {
    console.log('[ENPHASE-HISTORY] Dry run - not upserting data');
    if (recordsToUpsert.length > 0) {
      console.log('[ENPHASE-HISTORY] Sample record:', JSON.stringify(recordsToUpsert[0], null, 2));
    }
    return {
      intervalCount: recordsToUpsert.length,
      upsertedCount: 0,
      gapsFilled: filledGaps,
      errorCount: 0,
      dryRun: true,
      sampleRecord: recordsToUpsert[0]
    };
  }
  
  // Upsert records in batches
  const batchSize = 50; // Smaller batches for SQLite
  let upsertedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < recordsToUpsert.length; i += batchSize) {
    const batch = recordsToUpsert.slice(i, i + batchSize);
    
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
      
      console.log(`[ENPHASE-HISTORY] Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(recordsToUpsert.length / batchSize)} (${batch.length} records)`);
    } catch (error) {
      console.error(`[ENPHASE-HISTORY] Error upserting batch:`, error);
      errorCount += batch.length;
    }
  }
  
  console.log(`[ENPHASE-HISTORY] Complete - Upserted: ${upsertedCount}, Gaps filled: ${filledGaps}, Errors: ${errorCount}`);
  
  return {
    intervalCount: recordsToUpsert.length,
    upsertedCount,
    gapsFilled: filledGaps,
    errorCount
  };
}