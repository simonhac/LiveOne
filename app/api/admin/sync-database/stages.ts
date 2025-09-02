import { sql, and, eq, gte, lte } from 'drizzle-orm'
import { systems, readings, userSystems, clerkIdMapping, pollingStatus } from '@/lib/db/schema'
import { aggregateDailyData } from '@/lib/db/aggregate-daily'
import { updateAggregatedData } from '@/lib/aggregation-helper'
import { createClient } from '@libsql/client'
import { formatDateRange, fromUnixTimestamp } from '@/lib/date-utils'

export interface SyncContext {
  db: any
  prodDb: any
  signal: AbortSignal
  updateStage: (id: string, updates: any) => void
  send: (data: any) => void
  clerkMappings: Map<string, string>
  mapClerkId: (prodId: string | null | undefined) => string | undefined
  localLatestTime?: Date
  totalToSync?: number
  synced?: number
  formatDateTime: (date: Date) => string
}

export interface StageDefinition {
  id: string
  name: string
  estimatedDurationMs: number
  execute: (context: SyncContext) => Promise<{ 
    detail?: string
    context?: Partial<SyncContext> 
  }>
}

// Stage 1: Check local database
async function checkLocalDatabase(ctx: SyncContext) {
  const latestReading = await ctx.db.select()
    .from(readings)
    .orderBy(sql`inverter_time DESC`)
    .limit(1)
  
  const localLatestTime = latestReading[0]?.inverterTime || new Date(0)
  
  const systemCount = await ctx.db.select().from(systems)
  const readingCount = await ctx.db.select().from(readings)
  
  return {
    detail: `${systemCount.length} systems, ${readingCount.length.toLocaleString()} readings`,
    context: { localLatestTime }
  }
}

// Stage 2: Connect to production
async function connectToProduction(ctx: SyncContext) {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  })
  
  // Test connection
  await client.execute('SELECT 1')
  
  return {
    detail: 'Connected to Turso',
    context: { prodDb: client }  // Pass the client, not the drizzle instance
  }
}

// Stage 3: Load Clerk ID mappings
async function loadClerkMappings(ctx: SyncContext) {
  const clerkMappings = new Map<string, string>()
  
  try {
    const mappings = await ctx.db.select().from(clerkIdMapping)
    console.log(`[SYNC] Found ${mappings.length} Clerk ID mappings`)
    
    for (const mapping of mappings) {
      clerkMappings.set(mapping.prodClerkId, mapping.devClerkId)
      console.log(`[SYNC] Loaded mapping: ${mapping.username} - prod:${mapping.prodClerkId.slice(0, 15)}... -> dev:${mapping.devClerkId.slice(0, 15)}...`)
    }
    
    const mapClerkId = (prodId: string | null | undefined): string | undefined => {
      if (!prodId) return undefined
      const mapped = clerkMappings.get(prodId)
      if (!mapped) {
        console.log(`Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`)
      }
      return mapped
    }
    
    return {
      detail: `Loaded ${mappings.length} mappings`,
      context: { clerkMappings, mapClerkId }
    }
  } catch (err: any) {
    console.error('[SYNC] Error loading Clerk ID mappings:', err.message)
    
    const mapClerkId = (prodId: string | null | undefined): string | undefined => {
      console.log(`Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`)
      return undefined
    }
    
    return {
      detail: 'No mappings found',
      context: { clerkMappings, mapClerkId }
    }
  }
}

// Stage 4: Sync systems
async function syncSystems(ctx: SyncContext) {
  const prodSystems = await ctx.prodDb.execute('SELECT * FROM systems')
  let synced = 0
  let skipped = 0
  
  for (const sys of prodSystems.rows) {
    const mappedOwnerId = ctx.mapClerkId(sys.owner_clerk_user_id as string | null)
    
    if (!mappedOwnerId) {
      console.log(`Skipping system ${sys.id} - no dev mapping for owner ${sys.owner_clerk_user_id}`)
      skipped++
      continue
    }
    
    await ctx.db.insert(systems).values({
      id: sys.id as number,
      ownerClerkUserId: mappedOwnerId,
      vendorType: sys.vendor_type as string,
      vendorSiteId: sys.vendor_site_id as string,
      status: sys.status as string,
      displayName: sys.display_name as string,
      model: sys.model as string | undefined,
      serial: sys.serial as string | undefined,
      ratings: sys.ratings as string | undefined,
      solarSize: sys.solar_size as string | undefined,
      batterySize: sys.battery_size as string | undefined,
      location: sys.location as any,
      timezoneOffsetMin: sys.timezone_offset_min as number,
      createdAt: new Date(sys.created_at as number * 1000),
      updatedAt: new Date(sys.updated_at as number * 1000),
    }).onConflictDoUpdate({
      target: systems.id,
      set: {
        ownerClerkUserId: mappedOwnerId,
        vendorType: sys.vendor_type as string,
        vendorSiteId: sys.vendor_site_id as string,
        status: sys.status as string,
        displayName: sys.display_name as string,
        model: sys.model as string | undefined,
        serial: sys.serial as string | undefined,
        ratings: sys.ratings as string | undefined,
        solarSize: sys.solar_size as string | undefined,
        batterySize: sys.battery_size as string | undefined,
        location: sys.location as any,
        timezoneOffsetMin: sys.timezone_offset_min as number,
        updatedAt: new Date(),
      }
    })
    synced++
  }
  
  return {
    detail: `Synced ${synced} systems${skipped > 0 ? `, skipped ${skipped}` : ''}`
  }
}

// Stage 5: Count new data
async function countNewData(ctx: SyncContext) {
  const countResult = await ctx.prodDb.execute(
    `SELECT COUNT(*) as count FROM readings WHERE inverter_time > ?`,
    [Math.floor(ctx.localLatestTime!.getTime() / 1000)]
  )
  
  const totalToSync = countResult.rows[0]?.count as number || 0
  
  return {
    detail: `${totalToSync.toLocaleString()} new readings to sync`,
    context: { totalToSync }
  }
}

// Stage 6: Sync readings
async function syncReadings(ctx: SyncContext) {
  const BATCH_SIZE = 500
  let offset = 0
  let synced = 0
  let firstBatchTime: Date | null = null
  let lastBatchTime: Date | null = null
  
  console.log(`[SYNC] Starting readings sync: ${ctx.totalToSync} readings to download`)
  const syncStartTime = Date.now()
  
  while (synced < ctx.totalToSync!) {
    const batchStartTime = Date.now()
    if (ctx.signal.aborted) throw new Error('Sync cancelled')
    
    const dataProgress = 25 + (synced / ctx.totalToSync!) * 50
    const percentComplete = Math.round((synced / ctx.totalToSync!) * 100)
    
    // Fetch batch from production
    console.log(`[SYNC] Fetching batch ${Math.floor(offset / BATCH_SIZE) + 1}: offset=${offset}, limit=${BATCH_SIZE}`)
    const fetchStart = Date.now()
    
    const batchResult = await ctx.prodDb.execute(
      `SELECT * FROM readings 
       WHERE inverter_time > ? 
       ORDER BY inverter_time 
       LIMIT ? OFFSET ?`,
      [Math.floor(ctx.localLatestTime!.getTime() / 1000), BATCH_SIZE, offset]
    )
    
    const fetchTime = Date.now() - fetchStart
    console.log(`[SYNC] Fetched ${batchResult.rows.length} rows in ${fetchTime}ms`)
    
    if (batchResult.rows.length === 0) {
      console.log('[SYNC] No more rows to fetch, ending sync')
      break
    }
    
    // Track batch time range
    const batchFirstTime = new Date(batchResult.rows[0].inverter_time as number * 1000)
    const batchLastTime = new Date(batchResult.rows[batchResult.rows.length - 1].inverter_time as number * 1000)
    
    if (!firstBatchTime) firstBatchTime = batchFirstTime
    lastBatchTime = batchLastTime
    
    // Convert to ZonedDateTime for formatting (assuming Sydney timezone)
    const batchFirstZoned = fromUnixTimestamp(batchResult.rows[0].inverter_time as number, 600)
    const batchLastZoned = fromUnixTimestamp(batchResult.rows[batchResult.rows.length - 1].inverter_time as number, 600)
    
    // Update progress
    ctx.updateStage('sync-readings', { 
      detail: `Downloading batch from ${formatDateRange(batchFirstZoned, batchLastZoned, true)} (${percentComplete}%)`
    })
    
    ctx.send({ 
      type: 'progress', 
      message: `Syncing readings: ${synced.toLocaleString()} of ${ctx.totalToSync!.toLocaleString()} (${percentComplete}%)`, 
      progress: Math.round(dataProgress), 
      total: 100 
    })
    
    // Convert and insert batch
    const batchData = batchResult.rows.map((row: any) => ({
      systemId: row.system_id as number,
      inverterTime: new Date(row.inverter_time as number * 1000),
      receivedTime: new Date(row.received_time as number * 1000),
      delaySeconds: row.delay_seconds as number | undefined,
      solarW: row.solar_w as number,
      solarInverterW: row.solar_inverter_w as number,
      shuntW: row.shunt_w as number,
      loadW: row.load_w as number,
      batteryW: row.battery_w as number,
      gridW: row.grid_w as number,
      batterySOC: row.battery_soc as number,
      faultCode: row.fault_code as number,
      faultTimestamp: row.fault_timestamp as number,
      generatorStatus: row.generator_status as number,
      solarKwhTotal: row.solar_kwh_total as number | undefined,
      loadKwhTotal: row.load_kwh_total as number | undefined,
      batteryInKwhTotal: row.battery_in_kwh_total as number | undefined,
      batteryOutKwhTotal: row.battery_out_kwh_total as number | undefined,
      gridInKwhTotal: row.grid_in_kwh_total as number | undefined,
      gridOutKwhTotal: row.grid_out_kwh_total as number | undefined,
      createdAt: new Date(row.created_at as number * 1000),
    }))
    
    // Insert in chunks (SQLite has limits)
    const INSERT_CHUNK_SIZE = 100
    const insertStart = Date.now()
    let chunksInserted = 0
    
    for (let i = 0; i < batchData.length; i += INSERT_CHUNK_SIZE) {
      const chunk = batchData.slice(i, i + INSERT_CHUNK_SIZE)
      await ctx.db.insert(readings).values(chunk).onConflictDoNothing()
      chunksInserted++
    }
    
    const insertTime = Date.now() - insertStart
    console.log(`[SYNC] Inserted ${batchData.length} rows in ${chunksInserted} chunks (${insertTime}ms)`)
    
    synced += batchResult.rows.length
    offset += BATCH_SIZE
    
    const batchTime = Date.now() - batchStartTime
    console.log(`[SYNC] Batch complete: ${synced}/${ctx.totalToSync} synced (${Math.round((synced / ctx.totalToSync!) * 100)}%), batch took ${batchTime}ms`)
    
    // Small delay to prevent overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  
  const totalSyncTime = Date.now() - syncStartTime
  console.log(`[SYNC] Readings sync complete: ${synced} readings in ${(totalSyncTime / 1000).toFixed(1)}s (${(synced / (totalSyncTime / 1000)).toFixed(0)} readings/sec)`)
  
  // Format the date range if we have data
  let dateRangeStr = ''
  if (firstBatchTime && lastBatchTime) {
    const firstZoned = fromUnixTimestamp(Math.floor(firstBatchTime.getTime() / 1000), 600)
    const lastZoned = fromUnixTimestamp(Math.floor(lastBatchTime.getTime() / 1000), 600)
    dateRangeStr = ` (${formatDateRange(firstZoned, lastZoned, false)})`
  }
  
  return {
    detail: `Synced ${synced.toLocaleString()} readings${dateRangeStr}`,
    context: { synced }
  }
}

// Stage 7: Sync user systems
async function syncUserSystems(ctx: SyncContext) {
  let userSystemsProcessed = 0
  let skipped = 0
  
  const prodUserSystems = await ctx.prodDb.execute('SELECT * FROM user_systems')
  
  for (const us of prodUserSystems.rows) {
    const mappedClerkId = ctx.mapClerkId(us.clerk_user_id as string)
    
    if (!mappedClerkId) {
      console.log(`Skipping user_system ${us.id} - no dev mapping for user ${us.clerk_user_id}`)
      skipped++
      continue
    }
    
    // Check if this user-system mapping already exists
    const existing = await ctx.db
      .select()
      .from(userSystems)
      .where(
        and(
          eq(userSystems.clerkUserId, mappedClerkId),
          eq(userSystems.systemId, us.system_id as number)
        )
      )
      .limit(1)
    
    if (existing.length > 0) {
      // Update existing record
      await ctx.db
        .update(userSystems)
        .set({
          role: us.role as string,
          updatedAt: new Date(),
        })
        .where(eq(userSystems.id, existing[0].id))
    } else {
      // Insert new record (don't copy the ID from production)
      await ctx.db.insert(userSystems).values({
        clerkUserId: mappedClerkId,
        systemId: us.system_id as number,
        role: us.role as string,
        createdAt: new Date(us.created_at as number * 1000),
        updatedAt: new Date(us.updated_at as number * 1000),
      })
    }
    
    userSystemsProcessed++
  }
  
  return { detail: `Synced ${userSystemsProcessed} user-system mappings${skipped > 0 ? ` (${skipped} skipped)` : ''}` }
}

// Stage 8: Create 5-minute aggregations
async function create5MinAggregations(ctx: SyncContext) {
  const aggregationStart = Date.now()
  
  // Get the date range of synced data - use Drizzle query instead of raw SQL
  const newReadings = await ctx.db
    .select({
      minTime: sql<number>`MIN(inverter_time)`,
      maxTime: sql<number>`MAX(inverter_time)`,
      systemCount: sql<number>`COUNT(DISTINCT system_id)`,
      count: sql<number>`COUNT(*)`
    })
    .from(readings)
    .where(gte(readings.inverterTime, ctx.localLatestTime!))
  
  if (newReadings.length > 0 && newReadings[0].count > 0) {
    const minTime = newReadings[0].minTime
    const maxTime = newReadings[0].maxTime
    const systemCount = newReadings[0].systemCount
    
    console.log(`[SYNC] Creating 5-minute aggregations for ${newReadings[0].count} new readings across ${systemCount} systems`)
    
    // Get all unique 5-minute intervals that need aggregation
    const intervalMs = 5 * 60 * 1000
    const startInterval = new Date(Math.floor(minTime * 1000 / intervalMs) * intervalMs)
    const endInterval = new Date(Math.ceil(maxTime * 1000 / intervalMs) * intervalMs)
    
    // Get all systems that have new data
    const systemsWithNewData = await ctx.db
      .selectDistinct({ systemId: readings.systemId })
      .from(readings)
      .where(gte(readings.inverterTime, ctx.localLatestTime!))
    
    let aggregatedIntervals = 0
    for (const row of systemsWithNewData) {
      const systemId = row.systemId
      
      // Process each 5-minute interval for this system
      for (let intervalTime = startInterval.getTime(); intervalTime <= endInterval.getTime(); intervalTime += intervalMs) {
        await updateAggregatedData(systemId, new Date(intervalTime))
        aggregatedIntervals++
      }
    }
    
    const aggregationTime = (Date.now() - aggregationStart) / 1000
    return { 
      detail: `Created ${aggregatedIntervals} aggregations in ${aggregationTime.toFixed(1)}s` 
    }
  } else {
    return { detail: 'No new data to aggregate' }
  }
}

// Stage 9: Create daily aggregations
async function createDailyAggregations(ctx: SyncContext) {
  const dailyAggStart = Date.now()
  
  // Get distinct days that need aggregation using Drizzle
  const daysResult = await ctx.db
    .select({
      day: sql<string>`date(inverter_time, 'unixepoch', 'localtime')`,
      count: sql<number>`COUNT(*)`
    })
    .from(readings)
    .where(gte(readings.inverterTime, ctx.localLatestTime!))
    .groupBy(sql`date(inverter_time, 'unixepoch', 'localtime')`)
    .orderBy(sql`date(inverter_time, 'unixepoch', 'localtime')`)
  
  if (daysResult.length > 0) {
    console.log(`[SYNC] Creating daily aggregations for ${daysResult.length} days`)
    
    // Get all systems
    const systemsList = await ctx.db.select().from(systems)
    
    // Aggregate each day for each system
    for (const system of systemsList) {
      for (const row of daysResult) {
        await aggregateDailyData(system.id.toString(), row.day)
      }
    }
    
    const dailyAggTime = (Date.now() - dailyAggStart) / 1000
    return { 
      detail: `Aggregated ${daysResult.length} days in ${dailyAggTime.toFixed(1)}s` 
    }
  } else {
    return { detail: 'No days to aggregate' }
  }
}

// Combined stage: Prepare for sync (combines check local, connect to prod, load mappings)
async function prepareForSync(ctx: SyncContext) {
  // Step 1: Check local database
  const latestReading = await ctx.db.select()
    .from(readings)
    .orderBy(sql`inverter_time DESC`)
    .limit(1)
  
  const localLatestTime = latestReading[0]?.inverterTime || new Date(0)
  
  const systemCount = await ctx.db.select().from(systems)
  const readingCount = await ctx.db.select().from(readings)
  
  const localDetail = `${systemCount.length} systems, ${readingCount.length.toLocaleString()} readings`
  
  // Step 2: Connect to production
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  })
  
  // Test connection
  await client.execute('SELECT 1')
  
  // Step 3: Load Clerk ID mappings
  const clerkMappings = new Map<string, string>()
  
  try {
    const mappings = await ctx.db.select().from(clerkIdMapping)
    console.log(`[SYNC] Found ${mappings.length} Clerk ID mappings`)
    
    for (const mapping of mappings) {
      clerkMappings.set(mapping.prodClerkId, mapping.devClerkId)
      console.log(`[SYNC] Loaded mapping: ${mapping.username} - prod:${mapping.prodClerkId.slice(0, 15)}... -> dev:${mapping.devClerkId.slice(0, 15)}...`)
    }
    
    const mapClerkId = (prodId: string | null | undefined): string | undefined => {
      if (!prodId) return undefined
      const mapped = clerkMappings.get(prodId)
      if (!mapped) {
        console.log(`Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`)
      }
      return mapped
    }
    
    return {
      detail: `${localDetail}, ${mappings.length} mappings`,
      context: { 
        localLatestTime,
        prodDb: client,
        clerkMappings,
        mapClerkId
      }
    }
  } catch (err: any) {
    console.error('[SYNC] Error loading Clerk ID mappings:', err.message)
    
    const mapClerkId = (prodId: string | null | undefined): string | undefined => {
      console.log(`Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`)
      return undefined
    }
    
    return {
      detail: `${localDetail}, no mappings`,
      context: {
        localLatestTime,
        prodDb: client,
        clerkMappings,
        mapClerkId
      }
    }
  }
}

// Combined stage: Update aggregations (combines 5-minute and daily aggregations)
async function updateAggregations(ctx: SyncContext) {
  const aggregationStart = Date.now()
  let details: string[] = []
  
  // Part 1: Create 5-minute aggregations
  const newReadings = await ctx.db
    .select({
      minTime: sql<number>`MIN(inverter_time)`,
      maxTime: sql<number>`MAX(inverter_time)`,
      systemCount: sql<number>`COUNT(DISTINCT system_id)`,
      count: sql<number>`COUNT(*)`
    })
    .from(readings)
    .where(gte(readings.inverterTime, ctx.localLatestTime!))
  
  let aggregatedIntervals = 0
  if (newReadings.length > 0 && newReadings[0].count > 0) {
    const minTime = newReadings[0].minTime
    const maxTime = newReadings[0].maxTime
    const systemCount = newReadings[0].systemCount
    
    console.log(`[SYNC] Creating 5-minute aggregations for ${newReadings[0].count} new readings across ${systemCount} systems`)
    
    // Get all unique 5-minute intervals that need aggregation
    const intervalMs = 5 * 60 * 1000
    const startInterval = new Date(Math.floor(minTime * 1000 / intervalMs) * intervalMs)
    const endInterval = new Date(Math.ceil(maxTime * 1000 / intervalMs) * intervalMs)
    
    // Get all systems that have new data
    const systemsWithNewData = await ctx.db
      .selectDistinct({ systemId: readings.systemId })
      .from(readings)
      .where(gte(readings.inverterTime, ctx.localLatestTime!))
    
    for (const row of systemsWithNewData) {
      const systemId = row.systemId
      
      // Process each 5-minute interval for this system
      for (let intervalTime = startInterval.getTime(); intervalTime <= endInterval.getTime(); intervalTime += intervalMs) {
        await updateAggregatedData(systemId, new Date(intervalTime))
        aggregatedIntervals++
      }
    }
    
    const intervalText = aggregatedIntervals === 1 ? '1 5-min interval' : `${aggregatedIntervals} 5-min intervals`
    details.push(intervalText)
  }
  
  // Part 2: Create daily aggregations
  const dailyAggStart = Date.now()
  
  // Get distinct days that need aggregation using Drizzle
  const daysResult = await ctx.db
    .select({
      day: sql<string>`date(inverter_time, 'unixepoch', 'localtime')`,
      count: sql<number>`COUNT(*)`
    })
    .from(readings)
    .where(gte(readings.inverterTime, ctx.localLatestTime!))
    .groupBy(sql`date(inverter_time, 'unixepoch', 'localtime')`)
    .orderBy(sql`date(inverter_time, 'unixepoch', 'localtime')`)
  
  if (daysResult.length > 0) {
    console.log(`[SYNC] Creating daily aggregations for ${daysResult.length} days`)
    
    // Get all systems
    const systemsList = await ctx.db.select().from(systems)
    
    // Aggregate each day for each system
    for (const system of systemsList) {
      for (const row of daysResult) {
        await aggregateDailyData(system.id.toString(), row.day)
      }
    }
    
    const dayText = daysResult.length === 1 ? '1 day' : `${daysResult.length} days`
    details.push(dayText)
  }
  
  const aggregationTime = (Date.now() - aggregationStart) / 1000
  return { 
    detail: details.length > 0 ? details.join(', ') : 'No aggregations needed'
  }
}

// Stage 10: Finalise - cleanup and verification
async function finaliseSync(ctx: SyncContext) {
  // Close the production database connection
  if (ctx.prodDb) {
    await ctx.prodDb.close()
  }
  
  // Verify the sync by checking the latest reading
  const latestReading = await ctx.db.select()
    .from(readings)
    .orderBy(sql`inverter_time DESC`)
    .limit(1)
  
  const totalReadings = await ctx.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(readings)
  
  const systemCount = await ctx.db.select().from(systems)
  
  return { 
    detail: `${systemCount.length} systems, ${totalReadings[0].count.toLocaleString()} total readings`
  }
}

// Export the stage definitions with estimated durations
export const syncStages: StageDefinition[] = [
  { id: 'prepare', name: 'Prepare for sync', estimatedDurationMs: 1000, execute: prepareForSync },
  { id: 'sync-systems', name: 'Sync systems', estimatedDurationMs: 200, execute: syncSystems },
  { id: 'count-data', name: 'Count new data', estimatedDurationMs: 300, execute: countNewData },
  { id: 'sync-readings', name: 'Sync readings', estimatedDurationMs: 30000, execute: syncReadings }, // 30 seconds for bulk of data
  { id: 'sync-users', name: 'Sync user systems', estimatedDurationMs: 100, execute: syncUserSystems },
  { id: 'update-aggregations', name: 'Update aggregations', estimatedDurationMs: 700, execute: updateAggregations },
  { id: 'finalise', name: 'Finalise', estimatedDurationMs: 50, execute: finaliseSync },
]