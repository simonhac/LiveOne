import { sql, and, eq, gte, lte } from 'drizzle-orm'
import { systems, readings, userSystems, clerkIdMapping, pollingStatus, readingsAgg5m, readingsAgg1d } from '@/lib/db/schema'
import { createClient } from '@libsql/client'
import { formatDateRange, fromUnixTimestamp } from '@/lib/date-utils'

// Helper function to create a progress callback for time-based data syncing
function createTimeBasedProgressCallback(
  ctx: SyncContext,
  stageId: string
) {
  return (synced: number, total: number, rangeStart?: Date, rangeEnd?: Date, batchSize?: number) => {
    if (rangeStart && rangeEnd && ctx.totalToSync) {
      // Format the range for display
      const rangeStartZoned = fromUnixTimestamp(Math.floor(rangeStart.getTime() / 1000), 600)
      const rangeEndZoned = fromUnixTimestamp(Math.floor(rangeEnd.getTime() / 1000), 600)
      const rangeStr = formatDateRange(rangeStartZoned, rangeEndZoned, true)
      const percentComplete = Math.round((synced / ctx.totalToSync) * 100)
      
      ctx.updateStage(stageId, { 
        detail: `Downloading ${batchSize} records from ${rangeStr} (${percentComplete}%)`,
        progress: percentComplete
      })
    }
  }
}

// Generic function for syncing data between tables using raw SQL
interface SyncTableOptions {
  query: string
  queryParams: any[]
  mapRow?: (row: any) => any | null  // Optional: transform/filter rows (return null to skip)
  batchSize?: number
  chunkSize?: number
  delayBetweenBatches?: number  // Optional delay in ms between batches
  timestampField?: string  // Field to use for date range tracking (e.g., 'inverter_time')
  onProgress?: (synced: number, total: number, rangeStart?: Date, rangeEnd?: Date, batchSize?: number) => void
  onComplete?: (synced: number, firstTime?: Date, lastTime?: Date) => string  // Returns detail message
}

async function syncTableData(
  ctx: SyncContext,
  sourceTable: string,
  targetTable: string,
  options: SyncTableOptions
): Promise<{ synced: number, skipped: number, detail?: string }> {
  const {
    query,
    queryParams,
    mapRow,
    batchSize = 1000,
    chunkSize = 250,
    delayBetweenBatches = 0,
    timestampField,
    onProgress,
    onComplete
  } = options
  
  let offset = 0
  let totalSynced = 0
  let totalSkipped = 0
  let batchNum = 0
  let firstBatchTime: Date | null = null
  let lastBatchTime: Date | null = null
  const startTime = Date.now()
  
  while (!ctx.signal.aborted) {
    batchNum++
    const batchStartTime = Date.now()
    
    // Fetch batch from production
    console.log(`[SYNC] Fetching batch ${batchNum}: offset=${offset}, limit=${batchSize}`)
    const fetchStart = Date.now()
    
    const batchResult = await ctx.prodDb.execute(
      `${query} LIMIT ? OFFSET ?`,
      [...queryParams, batchSize, offset]
    )
    
    const fetchTime = Date.now() - fetchStart
    console.log(`[SYNC] Fetched ${batchResult.rows.length} rows in ${fetchTime}ms`)
    
    if (batchResult.rows.length === 0) {
      console.log('[SYNC] No more rows to fetch, ending sync')
      break
    }
    
    // Track date range if timestamp field specified
    let batchRangeStart: Date | undefined
    let batchRangeEnd: Date | undefined
    
    if (timestampField && batchResult.rows.length > 0) {
      batchRangeStart = new Date((batchResult.rows[0][timestampField] as number) * 1000)
      batchRangeEnd = new Date((batchResult.rows[batchResult.rows.length - 1][timestampField] as number) * 1000)
      
      if (!firstBatchTime) firstBatchTime = batchRangeStart
      lastBatchTime = batchRangeEnd
    }
    
    // Call progress callback before processing batch
    if (onProgress) {
      onProgress(totalSynced, totalSynced + offset, batchRangeStart, batchRangeEnd, batchResult.rows.length)
    }
    
    // Map rows and filter out nulls
    const batchData = []
    for (const row of batchResult.rows) {
      const mappedRow = mapRow ? mapRow(row) : row
      if (mappedRow) {
        batchData.push(mappedRow)
      } else {
        totalSkipped++
      }
    }
    
    if (batchData.length === 0) {
      offset += batchSize
      continue
    }
    
    // Insert in chunks using raw SQL
    const insertStart = Date.now()
    let chunksInserted = 0
    
    for (let i = 0; i < batchData.length; i += chunkSize) {
      const chunk = batchData.slice(i, i + chunkSize)
      
      if (chunk.length > 0) {
        // Get column names from first row
        const columns = Object.keys(chunk[0])
        
        // Build multi-row insert statement
        const values = chunk.map(row => 
          `(${columns.map(col => {
            const val = row[col]
            if (val === null || val === undefined) return 'NULL'
            if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`
            return val
          }).join(',')})`
        ).join(',')
        
        // Execute raw SQL insert
        const insertQuery = sql`INSERT OR IGNORE INTO ${sql.raw(targetTable)} (${sql.raw(columns.join(','))}) VALUES ${sql.raw(values)}`
        await ctx.db.run(insertQuery)
        chunksInserted++
      }
    }
    
    const insertTime = Date.now() - insertStart
    console.log(`[SYNC] Inserted ${batchData.length} ${targetTable} records in ${chunksInserted} chunks (${insertTime}ms)`)
    
    totalSynced += batchData.length
    offset += batchSize
    
    // Add delay between batches if specified
    if (delayBetweenBatches > 0 && batchResult.rows.length === batchSize) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches))
    }
  }
  
  // Call onComplete callback with date range if available
  let detail: string | undefined
  if (onComplete) {
    detail = onComplete(totalSynced, firstBatchTime || undefined, lastBatchTime || undefined)
  }
  
  return { synced: totalSynced, skipped: totalSkipped, detail }
}

export interface SyncContext {
  db: any
  prodDb: any
  signal: AbortSignal
  updateStage: (id: string, updates: any) => void
  send: (data: any) => void
  clerkMappings: Map<string, string>
  mapClerkId: (prodId: string | null | undefined) => string | undefined
  systemIdMappings: Map<number, number>  // Map prod systemId → dev systemId
  mapSystemId: (prodSystemId: number) => number | undefined
  localLatestTime?: Date
  syncFromTime?: Date  // The actual time to sync from (min 7 days back)
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
  const systemIdMappings = new Map<number, number>()
  let inserted = 0
  let updated = 0
  let skipped = 0
  
  // First, get all existing dev systems to check for duplicates
  const devSystems = await ctx.db.select().from(systems)
  const devSystemsMap = new Map<string, typeof devSystems[0]>()
  for (const devSys of devSystems) {
    const key = `${devSys.vendorType}:${devSys.vendorSiteId}`
    devSystemsMap.set(key, devSys)
  }
  
  for (const sys of prodSystems.rows) {
    const prodSystemId = sys.id as number
    const vendorType = sys.vendor_type as string
    const vendorSiteId = sys.vendor_site_id as string
    const key = `${vendorType}:${vendorSiteId}`
    
    const mappedOwnerId = ctx.mapClerkId(sys.owner_clerk_user_id as string | null)
    
    if (!mappedOwnerId) {
      console.log(`Skipping system ${prodSystemId} - no dev mapping for owner ${sys.owner_clerk_user_id}`)
      skipped++
      continue
    }
    
    // Check if this system already exists in dev
    const existingDevSystem = devSystemsMap.get(key)
    
    if (existingDevSystem) {
      // System exists - just update it and map the IDs
      systemIdMappings.set(prodSystemId, existingDevSystem.id)
      
      await ctx.db
        .update(systems)
        .set({
          ownerClerkUserId: mappedOwnerId,
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
        })
        .where(eq(systems.id, existingDevSystem.id))
      
      updated++
    } else {
      // System doesn't exist - insert it
      const result = await ctx.db.insert(systems).values({
        ownerClerkUserId: mappedOwnerId,
        vendorType: vendorType,
        vendorSiteId: vendorSiteId,
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
      }).returning({ id: systems.id })
      
      if (result.length > 0) {
        systemIdMappings.set(prodSystemId, result[0].id)
        inserted++
      }
    }
  }
  
  // Send mapping tables to frontend
  const systemMappingData = Array.from(systemIdMappings.entries()).map(([prodId, devId]) => ({
    'Prod ID': prodId,
    'Dev ID': devId,
    'System': devSystemsMap.get(
      Array.from(devSystemsMap.entries()).find(([_, sys]) => sys.id === devId)?.[0] || ''
    )?.displayName || 'Unknown'
  }))
  
  const clerkMappingData = Array.from(ctx.clerkMappings.entries()).map(([prodId, devId]) => ({
    'Prod Clerk ID': prodId.slice(0, 20) + '...',
    'Dev Clerk ID': devId.slice(0, 20) + '...',
  }))
  
  // Send to frontend
  ctx.send({
    type: 'mappings',
    systemMappings: systemMappingData,
    clerkMappings: clerkMappingData
  })
  
  // Create mapSystemId function
  const mapSystemId = (prodSystemId: number): number | undefined => {
    const mapped = systemIdMappings.get(prodSystemId)
    if (!mapped) {
      console.warn(`Warning: No dev system ID mapping for production ID: ${prodSystemId}`)
    }
    return mapped
  }
  
  return {
    detail: `Inserted ${inserted}, updated ${updated}${skipped > 0 ? `, skipped ${skipped}` : ''}`,
    context: { systemIdMappings, mapSystemId }
  }
}

// Stage 5: Count new data
async function countNewData(ctx: SyncContext) {
  // Force minimum 7 days of data
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const syncFromTime = ctx.localLatestTime! > sevenDaysAgo ? sevenDaysAgo : ctx.localLatestTime!
  
  const countResult = await ctx.prodDb.execute(
    `SELECT COUNT(*) as count FROM readings WHERE inverter_time > ?`,
    [Math.floor(syncFromTime.getTime() / 1000)]
  )
  
  const totalToSync = countResult.rows[0]?.count as number || 0
  
  // Store the actual sync start time in context
  const context = { 
    totalToSync,
    syncFromTime 
  }
  
  return {
    detail: `${totalToSync.toLocaleString()} readings to sync (min 7 days)`,
    context
  }
}

// Stage 6: Sync readings
async function syncReadings(ctx: SyncContext) {
  // Use syncFromTime if available (from countNewData), otherwise fall back to localLatestTime
  const syncFromTime = ctx.syncFromTime || ctx.localLatestTime!
  const syncFromTimestamp = Math.floor(syncFromTime.getTime() / 1000)
  
  console.log(`[SYNC] Starting readings sync: ${ctx.totalToSync} readings to download from ${syncFromTime.toISOString()}`)
  
  // Use generic sync function with progress tracking
  const result = await syncTableData(ctx, 'readings', 'readings', {
    query: `SELECT * FROM readings WHERE inverter_time > ? ORDER BY inverter_time`,
    queryParams: [syncFromTimestamp],
    mapRow: (row) => {
      // Map system IDs
      const mappedSystemId = ctx.mapSystemId(row.system_id as number)
      if (!mappedSystemId) {
        console.warn(`Skipping reading for unmapped system ${row.system_id}`)
        return null
      }
      return {
        ...row,
        system_id: mappedSystemId
      }
    },
    batchSize: 1000,
    chunkSize: 250,  // SQLite has a 999 variable limit
    delayBetweenBatches: 100,  // Small delay to prevent overwhelming the database
    timestampField: 'inverter_time',
    onProgress: createTimeBasedProgressCallback(ctx, 'sync-readings'),
    onComplete: (synced, firstTime, lastTime) => {
      // Format the date range if we have data
      let dateRangeStr = ''
      if (firstTime && lastTime) {
        const firstZoned = fromUnixTimestamp(Math.floor(firstTime.getTime() / 1000), 600)
        const lastZoned = fromUnixTimestamp(Math.floor(lastTime.getTime() / 1000), 600)
        dateRangeStr = ` (${formatDateRange(firstZoned, lastZoned, true)})`
      }
      return `Synced ${synced.toLocaleString()} readings${dateRangeStr}`
    }
  })
  
  return {
    detail: result.detail,
    context: { synced: result.synced }
  }
}

// Stage 7: Sync user systems
async function syncUserSystems(ctx: SyncContext) {
  let userSystemsProcessed = 0
  let skipped = 0
  
  const prodUserSystems = await ctx.prodDb.execute('SELECT * FROM user_systems')
  
  for (const us of prodUserSystems.rows) {
    const mappedClerkId = ctx.mapClerkId(us.clerk_user_id as string)
    const mappedSystemId = ctx.mapSystemId(us.system_id as number)
    
    if (!mappedClerkId) {
      console.log(`Skipping user_system ${us.id} - no dev mapping for user ${us.clerk_user_id}`)
      skipped++
      continue
    }
    
    if (!mappedSystemId) {
      console.log(`Skipping user_system ${us.id} - no dev mapping for system ${us.system_id}`)
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
          eq(userSystems.systemId, mappedSystemId)
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
      // Insert new record with mapped system ID
      await ctx.db.insert(userSystems).values({
        clerkUserId: mappedClerkId,
        systemId: mappedSystemId,
        role: us.role as string,
        createdAt: new Date(us.created_at as number * 1000),
        updatedAt: new Date(us.updated_at as number * 1000),
      })
    }
    
    userSystemsProcessed++
  }
  
  return { detail: `Synced ${userSystemsProcessed} user-system mappings${skipped > 0 ? ` (${skipped} skipped)` : ''}` }
}

// Stage 8: Sync 5-minute aggregations from production
async function sync5MinAggregations(ctx: SyncContext) {
  // Force minimum 7 days of aggregated data
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const syncFromTime = ctx.syncFromTime || sevenDaysAgo
  
  console.log(`[SYNC] Syncing 5-minute aggregations from ${syncFromTime.toISOString()}`)
  
  // Count total to sync
  const countResult = await ctx.prodDb.execute(
    `SELECT COUNT(*) as count FROM readings_agg_5m WHERE interval_end > ?`,
    [Math.floor(syncFromTime.getTime() / 1000)]
  )
  
  const totalToSync = countResult.rows[0]?.count as number || 0
  
  if (totalToSync === 0) {
    return { detail: 'No 5-minute aggregations to sync' }
  }
  
  console.log(`[SYNC] Syncing ${totalToSync} 5-minute aggregations`)
  
  // Set totalToSync in context for consistent progress tracking
  ctx.totalToSync = totalToSync
  
  // Clear existing aggregations in the sync range
  const syncFromTimestamp = Math.floor(syncFromTime.getTime() / 1000)
  const deleteResult = await ctx.db
    .delete(readingsAgg5m)
    .where(gte(readingsAgg5m.intervalEnd, syncFromTimestamp))
  
  // Use generic sync function
  const result = await syncTableData(ctx, 'readings_agg_5m', 'readings_agg_5m', {
    query: `SELECT * FROM readings_agg_5m WHERE interval_end > ? ORDER BY interval_end`,
    queryParams: [Math.floor(syncFromTime.getTime() / 1000)],
    mapRow: (row) => {
      // Map system IDs
      const mappedSystemId = ctx.mapSystemId(row.system_id as number)
      if (!mappedSystemId) {
        console.warn(`Skipping 5-min aggregation for unmapped system ${row.system_id}`)
        return null
      }
      return {
        ...row,
        system_id: mappedSystemId
      }
    },
    batchSize: 1000,
    timestampField: 'interval_end',  // 5-min aggregations use interval_end for timestamps
    onProgress: createTimeBasedProgressCallback(ctx, 'sync-5min-agg')
  })
  
  return { detail: `Synced ${result.synced.toLocaleString()} 5-minute aggregations` }
}


// Stage 9: Sync ALL daily aggregations from production
async function syncDailyAggregations(ctx: SyncContext) {
  const BATCH_SIZE = 1000
  let synced = 0
  
  console.log(`[SYNC] Syncing ALL daily aggregations from production`)
  
  // Count total daily aggregations in production
  const countResult = await ctx.prodDb.execute(
    `SELECT COUNT(*) as count FROM readings_agg_1d`
  )
  
  const totalToSync = countResult.rows[0]?.count as number || 0
  
  if (totalToSync === 0) {
    return { detail: 'No daily aggregations to sync' }
  }
  
  console.log(`[SYNC] Syncing ${totalToSync} daily aggregations`)
  
  // Set totalToSync in context for consistent progress tracking
  ctx.totalToSync = totalToSync
  
  // Clear ALL existing daily aggregations to replace with production data
  await ctx.db.delete(readingsAgg1d)
  
  // Use generic sync function
  const result = await syncTableData(ctx, 'readings_agg_1d', 'readings_agg_1d', {
    query: `SELECT * FROM readings_agg_1d ORDER BY system_id, day`,
    queryParams: [],
    mapRow: (row) => {
      // Map system IDs (system_id is TEXT in daily aggregations)
      const prodSystemId = parseInt(row.system_id as string)
      const mappedSystemId = ctx.mapSystemId(prodSystemId)
      if (!mappedSystemId) {
        console.warn(`Skipping daily aggregation for unmapped system ${prodSystemId}`)
        return null
      }
      return {
        ...row,
        system_id: mappedSystemId.toString() // Convert back to string for TEXT column
      }
    },
    onProgress: (synced, total) => {
      if (ctx.totalToSync) {
        const percentComplete = Math.round((synced / ctx.totalToSync) * 100)
        ctx.updateStage('sync-daily-agg', { 
          detail: `Syncing: ${synced.toLocaleString()} of ${ctx.totalToSync.toLocaleString()} (${percentComplete}%)`,
          progress: percentComplete
        })
      }
    }
  })
  
  return { detail: `Synced ${result.synced.toLocaleString()} daily aggregations` }
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
  { id: 'sync-5min-agg', name: 'Sync 5-min aggregations', estimatedDurationMs: 5000, execute: sync5MinAggregations },
  { id: 'sync-daily-agg', name: 'Sync daily aggregations', estimatedDurationMs: 3000, execute: syncDailyAggregations },
  { id: 'sync-users', name: 'Sync user systems', estimatedDurationMs: 100, execute: syncUserSystems },
  { id: 'finalise', name: 'Finalise', estimatedDurationMs: 50, execute: finaliseSync },
]