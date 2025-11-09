import { sql, and, eq, gte, lte } from "drizzle-orm";
import {
  systems,
  readings,
  userSystems,
  clerkIdMapping,
  pollingStatus,
  readingsAgg5m,
  readingsAgg1d,
  sessions,
  syncStatus,
} from "@/lib/db/schema";
import {
  pointInfo,
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/schema-monitoring-points";
import { createClient } from "@libsql/client";
import { fromUnixTimestamp } from "@/lib/date-utils";
import { formatDateTimeRange } from "@/lib/fe-date-format";
import { rawClient } from "@/lib/db";

// Sync configuration constants
const SYNC_BATCH_SIZE = 1000;
const SYNC_CHUNK_SIZE = 1000;
const SYNC_DELAY = 50; // Delay in ms between batches

// Helper function to calculate overall progress based on cumulative records
function calculateOverallProgress(
  ctx: SyncContext,
  currentStageSynced: number,
): number {
  const cumulativeSynced = ctx.cumulativeSynced || 0;
  const totalRecords = ctx.recordCounts
    ? Object.values(ctx.recordCounts).reduce((sum, count) => sum + count, 0)
    : 0;

  if (totalRecords === 0) return 0;

  const overallSynced = cumulativeSynced + currentStageSynced;
  return overallSynced / totalRecords;
}

// Helper function to create a progress callback (handles both time-based and count-based)
function createProgressCallback(ctx: SyncContext, stageId: string) {
  return (
    synced: number,
    total: number,
    rangeStart?: Date,
    rangeEnd?: Date,
    batchSize?: number,
    batchNum?: number,
  ) => {
    const stageTotal = ctx.recordCounts?.[stageId] || 0;
    if (stageTotal === 0) return;

    // Cap synced count at stageTotal (overlap can cause synced > total)
    const cappedSynced = Math.min(synced, stageTotal);

    // Calculate overall progress for the progress bar (cumulative across all stages)
    const overallProgress = calculateOverallProgress(ctx, cappedSynced);

    // Calculate stage-specific percentage for detail messages (capped at 100%)
    const stagePercent = Math.min(100, Math.round((synced / stageTotal) * 100));

    let detail: string;
    if (rangeStart && rangeEnd) {
      // Time-based format with date range
      const rangeStartZoned = fromUnixTimestamp(
        Math.floor(rangeStart.getTime() / 1000),
        600,
      );
      const rangeEndZoned = fromUnixTimestamp(
        Math.floor(rangeEnd.getTime() / 1000),
        600,
      );
      const rangeStr = formatDateTimeRange(
        rangeStartZoned,
        rangeEndZoned,
        true,
      );
      const batchStr = batchNum ? `Batch ${batchNum}: ` : "";
      detail = `${batchStr}Downloaded ${batchSize || cappedSynced} records from ${rangeStr} (${stagePercent}%)`;
    } else {
      // Simple count format
      detail = `Syncing: ${cappedSynced.toLocaleString()} of ${stageTotal.toLocaleString()} (${stagePercent}%)`;
    }

    ctx.updateStage(stageId, {
      detail,
      progress: overallProgress,
    });
  };
}

// Generic function for syncing data between tables using raw SQL
interface SyncTableOptions {
  query: string;
  queryParams: any[];
  mapRow?: (row: any) => any | null; // Optional: transform/filter rows (return null to skip)
  timestampField?: string; // Field to use for date range tracking (e.g., 'inverter_time')
  idField: string; // Field to use as secondary cursor to handle duplicate timestamps (e.g., 'id')
  chunkSize?: number; // Optional: Override chunk size for this table (default SYNC_CHUNK_SIZE)
  onProgress?: (
    synced: number,
    total: number,
    rangeStart?: Date,
    rangeEnd?: Date,
    batchSize?: number,
    batchNum?: number,
  ) => void;
  onComplete?: (synced: number, firstTime?: Date, lastTime?: Date) => string; // Returns detail message
}

async function syncTableData(
  ctx: SyncContext,
  sourceTable: string,
  targetTable: string,
  options: SyncTableOptions,
): Promise<{
  synced: number;
  skipped: number;
  detail?: string;
  lastBatchTime?: Date | null;
}> {
  const {
    query,
    queryParams,
    mapRow,
    timestampField,
    idField,
    chunkSize: customChunkSize,
    onProgress,
    onComplete,
  } = options;

  const batchSize = SYNC_BATCH_SIZE;
  const chunkSize = customChunkSize || SYNC_CHUNK_SIZE;

  let totalSynced = 0;
  let totalSkipped = 0;
  let batchNum = 0;
  let firstBatchTime: Date | null = null;
  let lastBatchTime: Date | null = null;
  let lastCursor: number | null = null; // Track last timestamp for cursor-based pagination
  let lastId: number | null = null; // Track last ID for handling duplicate timestamps
  let lastSystemId: number | null = null; // Track last system_id for composite PK tables

  while (!ctx.signal.aborted) {
    batchNum++;
    const fetchStart = Date.now();

    // Build query with composite cursor if available
    let paginatedQuery = query;
    let paginatedParams = [...queryParams];

    if (lastCursor !== null && timestampField) {
      // Simple cursor: fetch from last timestamp (inclusive)
      // This causes overlap but INSERT OR REPLACE handles duplicates
      // Avoids skipping records when multiple rows share the same timestamp
      const cursorCondition = `(${timestampField} >= ?)`;

      // Need to insert before ORDER BY clause if it exists
      const orderByMatch = query.match(/\s+ORDER\s+BY\s+/i);

      if (orderByMatch) {
        // Split query at ORDER BY
        const orderByIndex = orderByMatch.index!;
        const beforeOrderBy = query.substring(0, orderByIndex);
        const orderByClause = query.substring(orderByIndex);

        // Add cursor condition before ORDER BY
        if (query.toUpperCase().includes("WHERE")) {
          paginatedQuery = `${beforeOrderBy} AND ${cursorCondition}${orderByClause}`;
        } else {
          paginatedQuery = `${beforeOrderBy} WHERE ${cursorCondition}${orderByClause}`;
        }
      } else {
        // No ORDER BY, append at end
        if (query.toUpperCase().includes("WHERE")) {
          paginatedQuery = `${query} AND ${cursorCondition}`;
        } else {
          paginatedQuery = `${query} WHERE ${cursorCondition}`;
        }
      }

      // Add parameter: timestamp >= ?
      paginatedParams.push(lastCursor);
    } else if (lastSystemId !== null && lastId !== null && !timestampField) {
      // For tables without timestamps but with composite PK (system_id, id)
      // Add composite cursor condition: (system_id > lastSystemId) OR (system_id = lastSystemId AND id > lastId)
      const cursorCondition = `((system_id > ?) OR (system_id = ? AND ${idField} > ?))`;

      // Need to insert before ORDER BY clause if it exists
      const orderByMatch = query.match(/\s+ORDER\s+BY\s+/i);

      if (orderByMatch) {
        // Split query at ORDER BY
        const orderByIndex = orderByMatch.index!;
        const beforeOrderBy = query.substring(0, orderByIndex);
        const orderByClause = query.substring(orderByIndex);

        // Add cursor condition before ORDER BY
        if (query.toUpperCase().includes("WHERE")) {
          paginatedQuery = `${beforeOrderBy} AND ${cursorCondition}${orderByClause}`;
        } else {
          paginatedQuery = `${beforeOrderBy} WHERE ${cursorCondition}${orderByClause}`;
        }
      } else {
        // No ORDER BY, append at end
        if (query.toUpperCase().includes("WHERE")) {
          paginatedQuery = `${query} AND ${cursorCondition}`;
        } else {
          paginatedQuery = `${query} WHERE ${cursorCondition}`;
        }
      }

      // Add parameters: system_id > ?, system_id = ?, id > ?
      paginatedParams.push(lastSystemId, lastSystemId, lastId);
    }

    // Fetch batch from production using cursor-based pagination
    const finalQuery = `${paginatedQuery} LIMIT ?`;
    const finalParams = [...paginatedParams, batchSize];

    console.log(`[SYNC] Fetching batch ${batchNum}:`);
    console.log(`  Query: ${finalQuery}`);
    console.log(`  Params: ${JSON.stringify(finalParams)}`);

    const batchResult = await ctx.prodDb.execute(finalQuery, finalParams);

    const fetchTime = Date.now() - fetchStart;
    console.log(
      `[SYNC] Fetched ${batchResult.rows.length} rows in ${fetchTime}ms`,
    );

    if (batchResult.rows.length === 0) {
      console.log("[SYNC] No more rows to fetch, ending sync");
      break;
    }

    // Track date range and cursor if timestamp field specified
    let batchRangeStart: Date | undefined;
    let batchRangeEnd: Date | undefined;

    if (timestampField && batchResult.rows.length > 0) {
      const firstTimestamp = batchResult.rows[0][timestampField] as number;
      const lastRow = batchResult.rows[batchResult.rows.length - 1];
      const lastTimestamp = lastRow[timestampField] as number;

      // Check if we've exhausted all records at this timestamp
      // If all rows in batch have same timestamp AND batch is smaller than limit,
      // it means we've fetched everything at this timestamp
      const allSameTimestamp = firstTimestamp === lastTimestamp;
      const isPartialBatch = batchResult.rows.length < batchSize;

      if (allSameTimestamp && isPartialBatch) {
        // We've fetched all records at this timestamp
        // Increment by 1 to move to next timestamp (avoids infinite loop)
        lastCursor = lastTimestamp + 1;
      } else {
        // More records might exist at this timestamp, use >= for overlap
        lastCursor = lastTimestamp;
      }

      // Convert to dates (handle both seconds and milliseconds)
      // readings tables use seconds, point_readings use milliseconds
      const isMilliseconds = firstTimestamp > 10000000000;
      batchRangeStart = new Date(
        isMilliseconds ? firstTimestamp : firstTimestamp * 1000,
      );
      batchRangeEnd = new Date(
        isMilliseconds ? lastTimestamp : lastTimestamp * 1000,
      );

      if (!firstBatchTime) firstBatchTime = batchRangeStart;
      lastBatchTime = batchRangeEnd;
    } else if (!timestampField && batchResult.rows.length > 0) {
      // For tables without timestamps, track composite cursor (system_id, id)
      const lastRow = batchResult.rows[batchResult.rows.length - 1];
      lastSystemId = lastRow.system_id as number;
      lastId = lastRow[idField] as number;

      console.log(
        `[SYNC] Updated cursor: system_id=${lastSystemId}, id=${lastId}`,
      );
    }

    // Map rows and filter out nulls
    const batchData = [];
    for (const row of batchResult.rows) {
      const mappedRow = mapRow ? mapRow(row) : row;
      if (mappedRow) {
        batchData.push(mappedRow);
      } else {
        totalSkipped++;
      }
    }

    if (batchData.length === 0) {
      // No valid rows in this batch, continue to next
      continue;
    }

    // Insert in chunks using raw SQL
    const insertStart = Date.now();
    let chunksInserted = 0;
    let isFirstChunk = batchNum === 1 && totalSynced === 0;

    for (let i = 0; i < batchData.length; ) {
      // For the very first chunk of the sync, use size 1 as a test
      const currentChunkSize = isFirstChunk ? 1 : chunkSize;
      const chunk = batchData.slice(i, i + currentChunkSize);

      // Increment by actual chunk size (important for test chunk of size 1)
      i += chunk.length;

      if (chunk.length > 0) {
        // Get column names from first row
        const columns = Object.keys(chunk[0]);

        // Build multi-row insert statement
        const values = chunk
          .map(
            (row) =>
              `(${columns
                .map((col) => {
                  const val = row[col];
                  if (val === null || val === undefined) return "NULL";
                  if (typeof val === "string")
                    return `'${val.replace(/'/g, "''")}'`;
                  return val;
                })
                .join(",")})`,
          )
          .join(",");

        // Execute raw SQL insert using rawClient to avoid Drizzle's transaction handling
        const insertSQL = `INSERT OR REPLACE INTO ${targetTable} (${columns.join(",")}) VALUES ${values}`;
        const chunkLabel = isFirstChunk ? "[TEST]" : "";
        console.log(
          `[SYNC-RAW] ${chunkLabel} Executing INSERT OR REPLACE for ${targetTable}: ${chunk.length} rows (chunk ${chunksInserted + 1})`,
        );
        try {
          await rawClient.execute(insertSQL);
          chunksInserted++;
          console.log(
            `[SYNC-RAW] ✓ ${chunkLabel} Chunk ${chunksInserted} inserted successfully`,
          );

          // After first test chunk succeeds, switch to normal chunk size
          if (isFirstChunk) {
            console.log(
              `[SYNC-RAW] ✓ Test insert succeeded, continuing with chunk size ${chunkSize}`,
            );
            isFirstChunk = false;
          }
        } catch (insertError) {
          console.error(`[SYNC] INSERT failed for ${targetTable}:`);
          console.error(
            `  Error message:`,
            insertError instanceof Error
              ? insertError.message
              : String(insertError),
          );
          console.error(`  Exact SQL statement:\n${insertSQL}`);
          console.error(`  Columns (${columns.length}):`, columns);
          console.error(`  Chunk size:`, chunk.length);
          console.error(`  First row:`, chunk[0]);
          console.error(`  Last row:`, chunk[chunk.length - 1]);
          throw insertError;
        }
      }
    }

    const insertTime = Date.now() - insertStart;
    console.log(
      `[SYNC] Inserted ${batchData.length} ${targetTable} records in ${chunksInserted} chunks (${insertTime}ms)`,
    );

    totalSynced += batchData.length;

    // Call progress callback after processing batch
    // Note: totalSynced may be inflated due to overlapping batches (INSERT OR REPLACE handles duplicates)
    // but progress tracking uses this count for reporting
    if (onProgress) {
      console.log(
        `[SYNC] Calling onProgress: rangeStart=${batchRangeStart}, rangeEnd=${batchRangeEnd}, synced=${totalSynced}`,
      );
      onProgress(
        totalSynced,
        totalSynced, // Both params same since we count all fetched records
        batchRangeStart,
        batchRangeEnd,
        batchData.length,
        batchNum,
      );
    }

    // Add delay between batches
    if (SYNC_DELAY > 0 && batchResult.rows.length === batchSize) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY));
    }
  }

  // Call onComplete callback with date range if available
  let detail: string | undefined;
  if (onComplete) {
    detail = onComplete(
      totalSynced,
      firstBatchTime || undefined,
      lastBatchTime || undefined,
    );
  }

  return {
    synced: totalSynced,
    skipped: totalSkipped,
    detail,
    lastBatchTime: lastBatchTime || undefined, // Return the last timestamp for updating sync_status
  };
}

// Helper function to update sync_status table after a sync
async function updateSyncStatus(
  ctx: SyncContext,
  tableName: string,
  lastTime?: Date,
  lastDate?: string,
) {
  try {
    const lastEntryMs = lastTime ? lastTime.getTime() : null;

    // Upsert sync_status
    await rawClient.execute(
      `INSERT INTO sync_status (table_name, last_entry_ms, last_entry_date, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(table_name) DO UPDATE SET
         last_entry_ms = excluded.last_entry_ms,
         last_entry_date = excluded.last_entry_date,
         updated_at = excluded.updated_at`,
      [tableName, lastEntryMs, lastDate || null, Date.now()],
    );

    console.log(
      `[SYNC] Updated sync_status for ${tableName}: ${lastTime ? lastTime.toISOString() : lastDate || "N/A"}`,
    );
  } catch (err) {
    console.error(`[SYNC] Failed to update sync_status for ${tableName}:`, err);
  }
}

export interface SyncContext {
  db: any;
  prodDb: any;
  signal: AbortSignal;
  updateStage: (id: string, updates: any) => void;
  send: (data: any) => void;
  clerkMappings: Map<string, string>;
  mapClerkId: (prodId: string | null | undefined) => string | undefined;
  systemIdMappings: Map<number, number>; // Map prod systemId → dev systemId
  mapSystemId: (prodSystemId: number) => number | undefined;
  localLatestTime?: Date;
  syncFromTime?: Date; // The actual time to sync from (configurable days back)
  daysToSync: number; // Number of days to sync (0.25 = 6 hours, 1, 3, 7, or 14 days, -1 = automatic)
  totalToSync?: number;
  synced?: number;
  recordCounts?: Record<string, number>; // Map of stage id → record count
  cumulativeSynced?: number; // Total synced across all completed stages
  syncStatusMap?: Map<string, { ms?: number; date?: string }>; // Map of table name → last sync timestamp/date
  formatDateTime: (date: Date) => string;
}

export interface StageDefinition {
  id: string;
  name: string;
  modifiesMetadata: boolean; // If true, this stage modifies system/user metadata (destructive)
  execute: (context: SyncContext) => Promise<{
    detail?: string;
    context?: Partial<SyncContext>;
  }>;
}

// Stage 1: Check local database
async function checkLocalDatabase(ctx: SyncContext) {
  const latestReading = await ctx.db
    .select()
    .from(readings)
    .orderBy(sql`inverter_time DESC`)
    .limit(1);

  const localLatestTime = latestReading[0]?.inverterTime || new Date(0);

  const systemCount = await ctx.db.select().from(systems);
  const readingCount = await ctx.db.select().from(readings);

  return {
    detail: `${systemCount.length} systems, ${readingCount.length.toLocaleString()} readings`,
    context: { localLatestTime },
  };
}

// Stage 2: Connect to production
async function connectToProduction(ctx: SyncContext) {
  // IMPORTANT: For security, use a read-only Turso auth token for sync operations.
  // Generate a read-only token with: turso db tokens create <database> --read-only
  // Then set TURSO_AUTH_TOKEN_READONLY in your environment variables.
  //
  // All sync operations only READ from production and WRITE to local dev database.
  // Using a read-only token provides an additional safety layer.
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken:
      process.env.TURSO_AUTH_TOKEN_READONLY || process.env.TURSO_AUTH_TOKEN!,
  });

  // Test connection with a read-only query
  await client.execute("SELECT 1");

  return {
    detail: "Connected to Turso (read-only)",
    context: { prodDb: client }, // Pass the client, not the drizzle instance
  };
}

// Stage 3: Load Clerk ID mappings
async function loadClerkMappings(ctx: SyncContext) {
  const clerkMappings = new Map<string, string>();

  try {
    const mappings = await ctx.db.select().from(clerkIdMapping);
    console.log(`[SYNC] Found ${mappings.length} Clerk ID mappings`);

    for (const mapping of mappings) {
      clerkMappings.set(mapping.prodClerkId, mapping.devClerkId);
      console.log(
        `[SYNC] Loaded mapping: ${mapping.username} - prod:${mapping.prodClerkId.slice(0, 15)}... -> dev:${mapping.devClerkId.slice(0, 15)}...`,
      );
    }

    const mapClerkId = (
      prodId: string | null | undefined,
    ): string | undefined => {
      if (!prodId) return undefined;
      const mapped = clerkMappings.get(prodId);
      if (!mapped) {
        console.log(
          `Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`,
        );
      }
      return mapped;
    };

    return {
      detail: `Loaded ${mappings.length} mappings`,
      context: { clerkMappings, mapClerkId },
    };
  } catch (err: any) {
    console.error("[SYNC] Error loading Clerk ID mappings:", err.message);

    const mapClerkId = (
      prodId: string | null | undefined,
    ): string | undefined => {
      console.log(
        `Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`,
      );
      return undefined;
    };

    return {
      detail: "No mappings found",
      context: { clerkMappings, mapClerkId },
    };
  }
}

// Stage 4: Sync systems
async function syncSystems(ctx: SyncContext) {
  const prodSystems = await ctx.prodDb.execute("SELECT * FROM systems");
  const systemIdMappings = new Map<number, number>();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // First, get all existing dev systems to check for duplicates
  const devSystems = await ctx.db.select().from(systems);
  const devSystemsMap = new Map<string, (typeof devSystems)[0]>();
  for (const devSys of devSystems) {
    const key = `${devSys.vendorType}:${devSys.vendorSiteId}`;
    devSystemsMap.set(key, devSys);
  }

  const totalSystems = prodSystems.rows.length;
  let processed = 0;

  for (const sys of prodSystems.rows) {
    const prodSystemId = sys.id as number;
    const vendorType = sys.vendor_type as string;
    const vendorSiteId = sys.vendor_site_id as string;
    const key = `${vendorType}:${vendorSiteId}`;

    const mappedOwnerId = ctx.mapClerkId(
      sys.owner_clerk_user_id as string | null,
    );

    if (!mappedOwnerId) {
      console.log(
        `Skipping system ${prodSystemId} - no dev mapping for owner ${sys.owner_clerk_user_id}`,
      );
      skipped++;
      continue;
    }

    // Check if this system already exists in dev
    const existingDevSystem = devSystemsMap.get(key);

    if (existingDevSystem) {
      // System exists - just update it and map the IDs
      systemIdMappings.set(prodSystemId, existingDevSystem.id);

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
        .where(eq(systems.id, existingDevSystem.id));

      updated++;
    } else {
      // System doesn't exist - insert it
      const result = await ctx.db
        .insert(systems)
        .values({
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
          createdAt: new Date((sys.created_at as number) * 1000),
          updatedAt: new Date((sys.updated_at as number) * 1000),
        })
        .returning({ id: systems.id });

      if (result.length > 0) {
        systemIdMappings.set(prodSystemId, result[0].id);
        inserted++;
      }
    }
  }

  // Send mapping tables to frontend
  const systemMappingData = Array.from(systemIdMappings.entries()).map(
    ([prodId, devId]) => ({
      "Prod ID": prodId,
      "Dev ID": devId,
      System:
        devSystemsMap.get(
          Array.from(devSystemsMap.entries()).find(
            ([_, sys]) => sys.id === devId,
          )?.[0] || "",
        )?.displayName || "Unknown",
    }),
  );

  const clerkMappingData = Array.from(ctx.clerkMappings.entries()).map(
    ([prodId, devId]) => ({
      "Prod Clerk ID": prodId.slice(0, 20) + "...",
      "Dev Clerk ID": devId.slice(0, 20) + "...",
    }),
  );

  // Send to frontend
  ctx.send({
    type: "mappings",
    systemMappings: systemMappingData,
    clerkMappings: clerkMappingData,
  });

  // Create mapSystemId function
  const mapSystemId = (prodSystemId: number): number | undefined => {
    const mapped = systemIdMappings.get(prodSystemId);
    if (!mapped) {
      console.warn(
        `Warning: No dev system ID mapping for production ID: ${prodSystemId}`,
      );
    }
    return mapped;
  };

  return {
    detail: `Inserted ${inserted}, updated ${updated}${skipped > 0 ? `, skipped ${skipped}` : ""}`,
    context: { systemIdMappings, mapSystemId },
  };
}

// Stage 5: Count records to sync from all tables
async function countRecordsToSync(ctx: SyncContext) {
  let syncFromTime: Date;
  let syncFromTimestampSec: number;
  let syncFromTimestampMs: number;

  // Check if automatic mode (daysToSync === -1)
  if (ctx.daysToSync === -1) {
    // Automatic mode: Load last sync timestamps from sync_status table
    const syncStatusData = await ctx.db.select().from(syncStatus);
    const syncStatusMap = new Map<string, { ms?: number; date?: string }>();

    for (const row of syncStatusData) {
      syncStatusMap.set(row.tableName, {
        ms: row.lastEntryMs || undefined,
        date: row.lastEntryDate || undefined,
      });
    }

    // Find the earliest timestamp across all tables (to use as default)
    const timestamps = syncStatusData
      .map((row: { lastEntryMs: number | null }) => row.lastEntryMs)
      .filter(
        (ms: number | null): ms is number => ms !== null && ms !== undefined,
      );

    if (timestamps.length === 0) {
      throw new Error(
        "Automatic sync requires previous sync data. Please run a manual sync first.",
      );
    }

    const earliestMs = Math.min(...timestamps);
    syncFromTime = new Date(earliestMs);
    syncFromTimestampSec = Math.floor(earliestMs / 1000);
    syncFromTimestampMs = earliestMs;

    // Store sync status map in context for later use
    ctx.syncStatusMap = syncStatusMap;
  } else {
    // Manual mode: Sync the specified number of days
    const daysAgo = new Date(Date.now() - ctx.daysToSync * 24 * 60 * 60 * 1000);
    syncFromTime = daysAgo;
    syncFromTimestampSec = Math.floor(syncFromTime.getTime() / 1000);
    syncFromTimestampMs = syncFromTime.getTime();
  }

  // Count local records in all tables
  const localCountResult = await rawClient.execute(
    `SELECT
      (SELECT COUNT(*) FROM readings) as readings_count,
      (SELECT COUNT(*) FROM point_readings) as point_readings_count,
      (SELECT COUNT(*) FROM readings_agg_5m) as readings_agg_5m_count,
      (SELECT COUNT(*) FROM point_readings_agg_5m) as point_readings_agg_5m_count,
      (SELECT COUNT(*) FROM readings_agg_1d) as readings_agg_1d_count,
      (SELECT COUNT(*) FROM point_readings_agg_1d) as point_readings_agg_1d_count,
      (SELECT COUNT(*) FROM sessions) as sessions_count`,
  );

  const localRow = localCountResult.rows[0];
  const localCounts = {
    readings: (localRow?.readings_count as number) || 0,
    point_readings: (localRow?.point_readings_count as number) || 0,
    readings_agg_5m: (localRow?.readings_agg_5m_count as number) || 0,
    point_readings_agg_5m:
      (localRow?.point_readings_agg_5m_count as number) || 0,
    readings_agg_1d: (localRow?.readings_agg_1d_count as number) || 0,
    point_readings_agg_1d:
      (localRow?.point_readings_agg_1d_count as number) || 0,
    sessions: (localRow?.sessions_count as number) || 0,
  };

  // Count production records from all tables (only records to sync)
  const prodCountResult = await ctx.prodDb.execute(
    `SELECT
      (SELECT COUNT(*) FROM readings WHERE inverter_time > ?) as readings_count,
      (SELECT COUNT(*) FROM point_readings WHERE measurement_time > ?) as point_readings_count,
      (SELECT COUNT(*) FROM readings_agg_5m WHERE interval_end > ?) as readings_agg_5m_count,
      (SELECT COUNT(*) FROM point_readings_agg_5m WHERE interval_end > ?) as point_readings_agg_5m_count,
      (SELECT COUNT(*) FROM readings_agg_1d) as readings_agg_1d_count,
      (SELECT COUNT(*) FROM point_readings_agg_1d) as point_readings_agg_1d_count,
      (SELECT COUNT(*) FROM sessions WHERE started > ?) as sessions_count`,
    [
      syncFromTimestampSec,
      syncFromTimestampMs,
      syncFromTimestampSec,
      syncFromTimestampMs,
      syncFromTimestampSec,
    ],
  );

  const prodRow = prodCountResult.rows[0];
  const counts = {
    "sync-readings": (prodRow?.readings_count as number) || 0,
    "sync-point-readings": (prodRow?.point_readings_count as number) || 0,
    "sync-5min-agg": (prodRow?.readings_agg_5m_count as number) || 0,
    "sync-point-5min-agg":
      (prodRow?.point_readings_agg_5m_count as number) || 0,
    "sync-daily-agg": (prodRow?.readings_agg_1d_count as number) || 0,
    "sync-point-daily-agg":
      (prodRow?.point_readings_agg_1d_count as number) || 0,
    "sync-sessions": (prodRow?.sessions_count as number) || 0,
  };

  const totalToSync = counts["sync-readings"]; // Use readings count for overall progress

  // Store the sync time and counts in context
  const context = {
    totalToSync,
    syncFromTime,
    recordCounts: counts,
  };

  return {
    detail: `Local: ${localCounts.readings.toLocaleString()} readings, ${localCounts.point_readings.toLocaleString()} point readings`,
    context,
  };
}

// Stage 6: Sync readings
async function syncReadings(ctx: SyncContext) {
  // Use syncFromTime if available (from countNewData), otherwise fall back to localLatestTime
  const syncFromTime = ctx.syncFromTime || ctx.localLatestTime!;
  const syncFromTimestamp = Math.floor(syncFromTime.getTime() / 1000);

  // Get stage-specific total from recordCounts
  const stageTotal = ctx.recordCounts?.["sync-readings"] || 0;

  console.log(
    `[SYNC] Starting readings sync: ${stageTotal} readings to download from ${syncFromTime.toISOString()}`,
  );
  console.log(`[SYNC] recordCounts:`, ctx.recordCounts);
  console.log(`[SYNC] stageTotal for sync-readings:`, stageTotal);

  // Use generic sync function with progress tracking
  const result = await syncTableData(ctx, "readings", "readings", {
    query: `SELECT * FROM readings WHERE inverter_time > ? ORDER BY inverter_time, id`,
    queryParams: [syncFromTimestamp],
    mapRow: (row) => {
      // Map system IDs
      const mappedSystemId = ctx.mapSystemId(row.system_id as number);
      if (!mappedSystemId) {
        console.warn(`Skipping reading for unmapped system ${row.system_id}`);
        return null;
      }
      return {
        ...row,
        system_id: mappedSystemId,
      };
    },
    timestampField: "inverter_time",
    idField: "id",
    onProgress: createProgressCallback(ctx, "sync-readings"),
    onComplete: (synced, firstTime, lastTime) => {
      // Format the date range if we have data
      let dateRangeStr = "";
      if (firstTime && lastTime) {
        const firstZoned = fromUnixTimestamp(
          Math.floor(firstTime.getTime() / 1000),
          600,
        );
        const lastZoned = fromUnixTimestamp(
          Math.floor(lastTime.getTime() / 1000),
          600,
        );
        dateRangeStr = ` (${formatDateTimeRange(firstZoned, lastZoned, true)})`;
      }
      return `Synced ${synced.toLocaleString()} readings${dateRangeStr}`;
    },
  });

  // Update sync_status with the last synced timestamp
  if (result.lastBatchTime) {
    await updateSyncStatus(ctx, "readings", result.lastBatchTime);
  }

  return {
    detail: result.detail,
    context: { synced: result.synced },
  };
}

// Stage 7: Sync user systems
async function syncUserSystems(ctx: SyncContext) {
  let userSystemsProcessed = 0;
  let skipped = 0;

  const prodUserSystems = await ctx.prodDb.execute(
    "SELECT * FROM user_systems",
  );

  for (const us of prodUserSystems.rows) {
    const mappedClerkId = ctx.mapClerkId(us.clerk_user_id as string);
    const mappedSystemId = ctx.mapSystemId(us.system_id as number);

    if (!mappedClerkId) {
      console.log(
        `Skipping user_system ${us.id} - no dev mapping for user ${us.clerk_user_id}`,
      );
      skipped++;
      continue;
    }

    if (!mappedSystemId) {
      console.log(
        `Skipping user_system ${us.id} - no dev mapping for system ${us.system_id}`,
      );
      skipped++;
      continue;
    }

    // Check if this user-system mapping already exists
    const existing = await ctx.db
      .select()
      .from(userSystems)
      .where(
        and(
          eq(userSystems.clerkUserId, mappedClerkId),
          eq(userSystems.systemId, mappedSystemId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing record
      await ctx.db
        .update(userSystems)
        .set({
          role: us.role as string,
          updatedAt: new Date(),
        })
        .where(eq(userSystems.id, existing[0].id));
    } else {
      // Insert new record with mapped system ID
      await ctx.db.insert(userSystems).values({
        clerkUserId: mappedClerkId,
        systemId: mappedSystemId,
        role: us.role as string,
        createdAt: new Date((us.created_at as number) * 1000),
        updatedAt: new Date((us.updated_at as number) * 1000),
      });
    }

    userSystemsProcessed++;
  }

  return {
    detail: `Synced ${userSystemsProcessed} user-system mappings${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
  };
}

// Stage 8: Sync sessions
async function syncSessions(ctx: SyncContext) {
  const syncFromTime = ctx.syncFromTime || ctx.localLatestTime!;
  const syncFromTimestamp = Math.floor(syncFromTime.getTime() / 1000);

  // Get stage-specific total from recordCounts
  const stageTotal = ctx.recordCounts?.["sync-sessions"] || 0;

  console.log(
    `[SYNC] Starting sessions sync: ${stageTotal} sessions to download from ${syncFromTime.toISOString()}`,
  );

  if (stageTotal === 0) {
    return { detail: "No sessions to sync" };
  }

  // Clear existing sessions in the sync range
  await ctx.db
    .delete(sessions)
    .where(gte(sessions.started, new Date(syncFromTimestamp * 1000)));

  // Use generic sync function
  const result = await syncTableData(ctx, "sessions", "sessions", {
    query: `SELECT * FROM sessions WHERE started > ? ORDER BY started, id`,
    queryParams: [syncFromTimestamp],
    mapRow: (row) => {
      // Map system IDs
      const mappedSystemId = ctx.mapSystemId(row.system_id as number);
      if (!mappedSystemId) {
        console.warn(`Skipping session for unmapped system ${row.system_id}`);
        return null;
      }
      return {
        ...row,
        system_id: mappedSystemId,
      };
    },
    timestampField: "started",
    idField: "id",
    onProgress: createProgressCallback(ctx, "sync-sessions"),
    onComplete: (synced, firstTime, lastTime) => {
      // Format the date range if we have data
      let dateRangeStr = "";
      if (firstTime && lastTime) {
        const firstZoned = fromUnixTimestamp(
          Math.floor(firstTime.getTime() / 1000),
          600,
        );
        const lastZoned = fromUnixTimestamp(
          Math.floor(lastTime.getTime() / 1000),
          600,
        );
        dateRangeStr = ` (${formatDateTimeRange(firstZoned, lastZoned, true)})`;
      }
      return `Synced ${synced.toLocaleString()} sessions${dateRangeStr}`;
    },
  });

  // Update sync_status with the last synced timestamp
  if (result.lastBatchTime !== null && result.lastBatchTime !== undefined) {
    await updateSyncStatus(ctx, "sessions", result.lastBatchTime);
  }

  return {
    detail: result.detail,
    context: { synced: result.synced },
  };
}

// Stage: Sync 5-minute aggregations from production
async function sync5MinAggregations(ctx: SyncContext) {
  const syncFromTime = ctx.syncFromTime!;

  // Get stage-specific total from recordCounts
  const stageTotal = ctx.recordCounts?.["sync-5min-agg"] || 0;

  console.log(
    `[SYNC] Syncing ${stageTotal} 5-minute aggregations from ${syncFromTime.toISOString()}`,
  );

  if (stageTotal === 0) {
    return { detail: "No 5-minute aggregations to sync" };
  }

  // Clear existing aggregations in the sync range
  const syncFromTimestamp = Math.floor(syncFromTime.getTime() / 1000);
  const deleteResult = await ctx.db
    .delete(readingsAgg5m)
    .where(gte(readingsAgg5m.intervalEnd, syncFromTimestamp));

  // Use generic sync function
  const result = await syncTableData(
    ctx,
    "readings_agg_5m",
    "readings_agg_5m",
    {
      query: `SELECT * FROM readings_agg_5m WHERE interval_end > ? ORDER BY interval_end, system_id`,
      queryParams: [Math.floor(syncFromTime.getTime() / 1000)],
      mapRow: (row) => {
        // Map system IDs
        const mappedSystemId = ctx.mapSystemId(row.system_id as number);
        if (!mappedSystemId) {
          console.warn(
            `Skipping 5-min aggregation for unmapped system ${row.system_id}`,
          );
          return null;
        }
        return {
          ...row,
          system_id: mappedSystemId,
        };
      },
      timestampField: "interval_end", // 5-min aggregations use interval_end for timestamps
      idField: "system_id", // Use system_id as secondary cursor (part of composite PK)
      onProgress: createProgressCallback(ctx, "sync-5min-agg"),
    },
  );

  // Update sync_status with the last synced timestamp
  if (result.lastBatchTime) {
    await updateSyncStatus(ctx, "readings_agg_5m", result.lastBatchTime);
  }

  return {
    detail: `Synced ${result.synced.toLocaleString()} 5-minute aggregations`,
  };
}

// Stage: Sync point_readings_agg_5m (5-minute aggregations for monitoring points)
async function syncPointReadings5MinAggregations(ctx: SyncContext) {
  const syncFromTime = ctx.syncFromTime!;
  const syncFromTimestamp = syncFromTime.getTime(); // point_readings_agg_5m uses milliseconds

  // Get stage-specific total from recordCounts
  const stageTotal = ctx.recordCounts?.["sync-point-5min-agg"] || 0;

  console.log(
    `[SYNC] Starting point_readings 5-minute aggregations sync: ${stageTotal} aggregations to download from ${syncFromTime.toISOString()}`,
  );

  if (stageTotal === 0) {
    return { detail: "No point_readings 5-minute aggregations to sync" };
  }

  // Get mapping of production point_info IDs to development point_info IDs
  const prodPointInfo = await ctx.prodDb.execute(
    `SELECT id, system_id, origin_id, origin_sub_id FROM point_info`,
  );

  const devPointInfo = await ctx.db
    .select({
      id: pointInfo.id,
      systemId: pointInfo.systemId,
      originId: pointInfo.originId,
      originSubId: pointInfo.originSubId,
    })
    .from(pointInfo);

  // Create mapping: prod system_id:point_id -> dev point_id
  // NOTE: Point IDs are NOT globally unique - they're system-specific (composite PK: system_id + id)
  // So we must include system_id in the mapping key to avoid collisions
  const pointIdMapping = new Map<string, number>();

  for (const prodPoint of prodPointInfo.rows) {
    const prodSystemId = prodPoint.system_id as number;
    const devSystemId = ctx.mapSystemId(prodSystemId);

    if (!devSystemId) continue;

    // Find matching dev point_info by system_id, origin_id, and origin_sub_id
    const devPoint = devPointInfo.find(
      (p: any) =>
        p.systemId === devSystemId &&
        p.originId === prodPoint.origin_id &&
        p.originSubId === prodPoint.origin_sub_id,
    );

    if (devPoint) {
      // Use composite key: ${prodSystemId}:${prodPointId}
      const key = `${prodSystemId}:${prodPoint.id}`;
      pointIdMapping.set(key, devPoint.id);
    }
  }

  console.log(
    `[SYNC] Mapped ${pointIdMapping.size} point_info IDs for aggregations`,
  );

  // Use generic sync function
  const result = await syncTableData(
    ctx,
    "point_readings_agg_5m",
    "point_readings_agg_5m",
    {
      query: `SELECT * FROM point_readings_agg_5m WHERE interval_end > ? ORDER BY interval_end, system_id, point_id`,
      queryParams: [syncFromTimestamp],
      mapRow: (row) => {
        // Map point_info IDs using composite key (system_id:point_id)
        const pointKey = `${row.system_id}:${row.point_id}`;
        const mappedPointId = pointIdMapping.get(pointKey);
        if (!mappedPointId) {
          // Silently skip unmapped points (expected for systems we don't have)
          return null;
        }

        // Map system IDs
        const mappedSystemId = ctx.mapSystemId(row.system_id as number);
        if (!mappedSystemId) {
          return null;
        }

        return {
          ...row,
          point_id: mappedPointId,
          system_id: mappedSystemId,
        };
      },
      timestampField: "interval_end",
      idField: "point_id", // Use point_id as secondary cursor (part of composite PK)
      onProgress: createProgressCallback(ctx, "sync-point-5min-agg"),
    },
  );

  // Update sync_status with the last synced timestamp
  if (result.lastBatchTime !== null && result.lastBatchTime !== undefined) {
    await updateSyncStatus(ctx, "point_readings_agg_5m", result.lastBatchTime);
  }

  return {
    detail: `Synced ${result.synced.toLocaleString()} point_readings 5-minute aggregations`,
  };
}

// Stage 9: Sync ALL daily aggregations from production
async function syncDailyAggregations(ctx: SyncContext) {
  const totalToSync = ctx.recordCounts?.["sync-daily-agg"] || 0;

  if (totalToSync === 0) {
    return { detail: "No daily aggregations to sync" };
  }

  console.log(`[SYNC] Syncing ${totalToSync} daily aggregations`);

  // Clear ALL existing daily aggregations to replace with production data
  await ctx.db.delete(readingsAgg1d);

  // Fetch all daily aggregations from production (no pagination needed for small dataset)
  const prodData = await ctx.prodDb.execute(
    `SELECT * FROM readings_agg_1d ORDER BY system_id, day`,
  );

  let synced = 0;
  let skipped = 0;

  // Map and insert records
  const mappedData = [];
  for (const row of prodData.rows) {
    const prodSystemId = parseInt(row.system_id as string);
    const mappedSystemId = ctx.mapSystemId(prodSystemId);
    if (!mappedSystemId) {
      console.warn(
        `Skipping daily aggregation for unmapped system ${prodSystemId}`,
      );
      skipped++;
      continue;
    }
    mappedData.push({
      ...row,
      system_id: mappedSystemId.toString(), // Convert back to string for TEXT column
    });
  }

  // Update progress
  const stageTotal = ctx.recordCounts?.["sync-daily-agg"] || 0;
  if (stageTotal > 0) {
    const overallProgress = calculateOverallProgress(ctx, mappedData.length);
    ctx.updateStage("sync-daily-agg", {
      detail: `Syncing: ${mappedData.length.toLocaleString()} of ${stageTotal.toLocaleString()} (${Math.round(overallProgress * 100)}%)`,
      progress: overallProgress,
    });
  }

  if (mappedData.length > 0) {
    // Get column names from first row
    const columns = Object.keys(mappedData[0]);

    // Build multi-row insert statement
    const values = mappedData
      .map(
        (row) =>
          `(${columns
            .map((col) => {
              const val = row[col];
              if (val === null || val === undefined) return "NULL";
              if (typeof val === "string")
                return `'${val.replace(/'/g, "''")}'`;
              return val;
            })
            .join(",")})`,
      )
      .join(",");

    // Execute raw SQL insert
    const insertQuery = sql`INSERT OR IGNORE INTO ${sql.raw("readings_agg_1d")} (${sql.raw(columns.join(","))}) VALUES ${sql.raw(values)}`;
    await ctx.db.run(insertQuery);
    synced = mappedData.length;

    // Update sync_status with the last synced date
    const lastDay = prodData.rows[prodData.rows.length - 1]?.day as string;
    if (lastDay) {
      await updateSyncStatus(ctx, "readings_agg_1d", undefined, lastDay);
    }
  }

  return {
    detail: `Synced ${synced.toLocaleString()} daily aggregations${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
  };
}

// Stage: Sync point_readings_agg_1d (daily aggregations for monitoring points)
async function syncPointDailyAggregations(ctx: SyncContext) {
  const totalToSync = ctx.recordCounts?.["sync-point-daily-agg"] || 0;

  if (totalToSync === 0) {
    return { detail: "No point daily aggregations to sync" };
  }

  console.log(`[SYNC] Syncing ${totalToSync} point daily aggregations`);

  // Clear ALL existing point daily aggregations to replace with production data
  await ctx.db.delete(pointReadingsAgg1d);

  // Get mapping of production point_info IDs to development point_info IDs
  const prodPointInfo = await ctx.prodDb.execute(
    `SELECT id, system_id, origin_id, origin_sub_id FROM point_info`,
  );

  const devPointInfo = await ctx.db
    .select({
      id: pointInfo.id,
      systemId: pointInfo.systemId,
      originId: pointInfo.originId,
      originSubId: pointInfo.originSubId,
    })
    .from(pointInfo);

  // Create mapping: prod system_id:point_id -> dev point_id
  const pointIdMapping = new Map<string, number>();

  for (const prodPoint of prodPointInfo.rows) {
    const prodSystemId = prodPoint.system_id as number;
    const devSystemId = ctx.mapSystemId(prodSystemId);

    if (!devSystemId) continue;

    // Find matching dev point_info by system_id, origin_id, and origin_sub_id
    const devPoint = devPointInfo.find(
      (p: any) =>
        p.systemId === devSystemId &&
        p.originId === prodPoint.origin_id &&
        p.originSubId === prodPoint.origin_sub_id,
    );

    if (devPoint) {
      // Use composite key: ${prodSystemId}:${prodPointId}
      const key = `${prodSystemId}:${prodPoint.id}`;
      pointIdMapping.set(key, devPoint.id);
    }
  }

  console.log(
    `[SYNC] Mapped ${pointIdMapping.size} point_info IDs for daily aggregations`,
  );

  // Use generic sync function
  const result = await syncTableData(
    ctx,
    "point_readings_agg_1d",
    "point_readings_agg_1d",
    {
      query: `SELECT * FROM point_readings_agg_1d ORDER BY system_id, point_id, day`,
      queryParams: [],
      mapRow: (row) => {
        // Map point_info IDs using composite key (system_id:point_id)
        const pointKey = `${row.system_id}:${row.point_id}`;
        const mappedPointId = pointIdMapping.get(pointKey);
        if (!mappedPointId) {
          // Silently skip unmapped points (expected for systems we don't have)
          return null;
        }

        // Map system IDs
        const mappedSystemId = ctx.mapSystemId(row.system_id as number);
        if (!mappedSystemId) {
          return null;
        }

        return {
          ...row,
          point_id: mappedPointId,
          system_id: mappedSystemId,
        };
      },
      idField: "point_id", // Use point_id as cursor (part of composite PK)
      onProgress: createProgressCallback(ctx, "sync-point-daily-agg"),
    },
  );

  // Update sync_status with the last synced day
  const prodData = await ctx.prodDb.execute(
    `SELECT day FROM point_readings_agg_1d ORDER BY day DESC LIMIT 1`,
  );
  const lastDay = prodData.rows[0]?.day as string;
  if (lastDay) {
    await updateSyncStatus(ctx, "point_readings_agg_1d", undefined, lastDay);
  }

  return {
    detail: `Synced ${result.synced.toLocaleString()} point daily aggregations`,
  };
}

// Combined stage: Prepare for sync (combines check local, connect to prod, load mappings)
async function prepareForSync(ctx: SyncContext) {
  // Step 1: Check local database
  const latestReading = await ctx.db
    .select()
    .from(readings)
    .orderBy(sql`inverter_time DESC`)
    .limit(1);

  const localLatestTime = latestReading[0]?.inverterTime || new Date(0);

  const systemCount = await ctx.db.select().from(systems);

  const localDetail = `${systemCount.length} systems`;

  // Step 2: Connect to production (using read-only token if available)
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken:
      process.env.TURSO_AUTH_TOKEN_READONLY || process.env.TURSO_AUTH_TOKEN!,
  });

  // Test connection
  await client.execute("SELECT 1");

  // Step 3: Load Clerk ID mappings
  const clerkMappings = new Map<string, string>();
  let clerkMappingsCount = 0;

  try {
    const mappings = await ctx.db.select().from(clerkIdMapping);
    console.log(`[SYNC] Found ${mappings.length} Clerk ID mappings`);
    clerkMappingsCount = mappings.length;

    for (const mapping of mappings) {
      clerkMappings.set(mapping.prodClerkId, mapping.devClerkId);
      console.log(
        `[SYNC] Loaded mapping: ${mapping.username} - prod:${mapping.prodClerkId.slice(0, 15)}... -> dev:${mapping.devClerkId.slice(0, 15)}...`,
      );
    }
  } catch (err: any) {
    console.error("[SYNC] Error loading Clerk ID mappings:", err.message);
    // Continue without Clerk mappings - system mappings can still work
  }

  const mapClerkId = (
    prodId: string | null | undefined,
  ): string | undefined => {
    if (!prodId) return undefined;
    const mapped = clerkMappings.get(prodId);
    if (!mapped) {
      console.log(
        `Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`,
      );
    }
    return mapped;
  };

  // Step 4: Build system ID mappings (non-destructive - just match existing systems)
  const systemIdMappings = new Map<number, number>();

  try {
    // Get all production systems
    const prodSystems = await client.execute("SELECT * FROM systems");

    // Get all dev systems and index by vendor_type:vendor_site_id
    const devSystems = await ctx.db.select().from(systems);
    const devSystemsMap = new Map<string, (typeof devSystems)[0]>();
    for (const devSys of devSystems) {
      const key = `${devSys.vendorType}:${devSys.vendorSiteId}`;
      devSystemsMap.set(key, devSys);
    }

    // Match prod systems to dev systems by vendor_type:vendor_site_id
    for (const sys of prodSystems.rows) {
      const prodSystemId = sys.id as number;
      const vendorType = sys.vendor_type as string;
      const vendorSiteId = sys.vendor_site_id as string;
      const key = `${vendorType}:${vendorSiteId}`;

      // Check if this system exists in dev
      const existingDevSystem = devSystemsMap.get(key);
      if (existingDevSystem) {
        systemIdMappings.set(prodSystemId, existingDevSystem.id);
        console.log(
          `[SYNC] System mapping: prod ${prodSystemId} (${key}) -> dev ${existingDevSystem.id}`,
        );
      }
    }

    console.log(`[SYNC] Built ${systemIdMappings.size} system ID mappings`);
  } catch (err: any) {
    console.error("[SYNC] Error building system ID mappings:", err.message);
    // Continue with empty system mappings - sessions/readings will be skipped
  }

  const mapSystemId = (prodSystemId: number): number | undefined => {
    const mapped = systemIdMappings.get(prodSystemId);
    if (!mapped) {
      console.warn(
        `Warning: No dev system ID mapping for production ID: ${prodSystemId}`,
      );
    }
    return mapped;
  };

  return {
    detail: `${localDetail}, ${clerkMappingsCount} Clerk mappings, ${systemIdMappings.size} system mappings`,
    context: {
      localLatestTime,
      prodDb: client,
      clerkMappings,
      mapClerkId,
      systemIdMappings,
      mapSystemId,
    },
  };
}

// Stage 10: Sync point_info (monitoring points metadata)
async function syncPointInfo(ctx: SyncContext) {
  console.log(`[SYNC] Syncing point_info from production`);

  // Count total point_info in production
  const countResult = await ctx.prodDb.execute(
    `SELECT COUNT(*) as count FROM point_info`,
  );

  const totalToSync = (countResult.rows[0]?.count as number) || 0;

  if (totalToSync === 0) {
    return { detail: "No point_info to sync" };
  }

  console.log(`[SYNC] Syncing ${totalToSync} point_info records`);

  // Clear ALL existing point_info to replace with production data
  await ctx.db.delete(pointInfo);

  // Use generic sync function
  const result = await syncTableData(ctx, "point_info", "point_info", {
    query: `SELECT * FROM point_info ORDER BY system_id, id`,
    queryParams: [],
    mapRow: (row) => {
      // Map system IDs
      const mappedSystemId = ctx.mapSystemId(row.system_id as number);
      if (!mappedSystemId) {
        console.warn(
          `Skipping point_info for unmapped system ${row.system_id}`,
        );
        return null;
      }
      return {
        ...row,
        system_id: mappedSystemId,
      };
    },
    idField: "id", // Use id as cursor (part of composite PK: system_id, id)
    onProgress: createProgressCallback(ctx, "sync-point-info"),
  });

  return {
    detail: `Synced ${result.synced.toLocaleString()} point_info records`,
  };
}

// Stage 11: Sync point_readings (monitoring points time-series data)
async function syncPointReadings(ctx: SyncContext) {
  const syncFromTime = ctx.syncFromTime!;
  const syncFromTimestamp = syncFromTime.getTime(); // point_readings uses milliseconds

  // Get stage-specific total from recordCounts
  const stageTotal = ctx.recordCounts?.["sync-point-readings"] || 0;

  console.log(
    `[SYNC] Starting point_readings sync: ${stageTotal} point readings to download from ${syncFromTime.toISOString()}`,
  );

  if (stageTotal === 0) {
    return { detail: "No point_readings to sync" };
  }

  // First, get mapping of production point_info IDs to development point_info IDs
  const prodPointInfo = await ctx.prodDb.execute(
    `SELECT id, system_id, origin_id, origin_sub_id FROM point_info`,
  );

  const devPointInfo = await ctx.db
    .select({
      id: pointInfo.id,
      systemId: pointInfo.systemId,
      originId: pointInfo.originId,
      originSubId: pointInfo.originSubId,
    })
    .from(pointInfo);

  // Create mapping: prod system_id:point_id -> dev point_id
  // NOTE: Point IDs are NOT globally unique - they're system-specific (composite PK: system_id + id)
  // So we must include system_id in the mapping key to avoid collisions
  const pointIdMapping = new Map<string, number>();

  for (const prodPoint of prodPointInfo.rows) {
    const prodSystemId = prodPoint.system_id as number;
    const devSystemId = ctx.mapSystemId(prodSystemId);

    if (!devSystemId) continue;

    // Find matching dev point_info by system_id, origin_id, and origin_sub_id
    const devPoint = devPointInfo.find(
      (p: any) =>
        p.systemId === devSystemId &&
        p.originId === prodPoint.origin_id &&
        p.originSubId === prodPoint.origin_sub_id,
    );

    if (devPoint) {
      // Use composite key: ${prodSystemId}:${prodPointId}
      const key = `${prodSystemId}:${prodPoint.id}`;
      pointIdMapping.set(key, devPoint.id);
    }
  }

  console.log(`[SYNC] Mapped ${pointIdMapping.size} point_info IDs`);

  // Use generic sync function
  const result = await syncTableData(ctx, "point_readings", "point_readings", {
    query: `SELECT * FROM point_readings WHERE measurement_time > ? ORDER BY measurement_time, id`,
    queryParams: [syncFromTimestamp],
    chunkSize: 1000, // Batch 1000 rows per INSERT (will test with 1 first)
    mapRow: (row) => {
      // Map point_info IDs using composite key (system_id:point_id)
      const pointKey = `${row.system_id}:${row.point_id}`;
      const mappedPointId = pointIdMapping.get(pointKey);
      if (!mappedPointId) {
        // Silently skip unmapped points (expected for systems we don't have)
        return null;
      }

      // Map system IDs
      const mappedSystemId = ctx.mapSystemId(row.system_id as number);
      if (!mappedSystemId) {
        return null;
      }

      return {
        ...row,
        point_id: mappedPointId,
        system_id: mappedSystemId,
        value_str: null, // Production doesn't have value_str column yet, add it for dev compatibility
      };
    },
    timestampField: "measurement_time", // syncTableData handles milliseconds automatically
    idField: "id",
    onProgress: createProgressCallback(ctx, "sync-point-readings"),
    onComplete: (synced, firstTime, lastTime) => {
      // Format the date range if we have data
      let dateRangeStr = "";
      if (firstTime && lastTime) {
        const firstZoned = fromUnixTimestamp(
          Math.floor(firstTime.getTime() / 1000),
          600,
        );
        const lastZoned = fromUnixTimestamp(
          Math.floor(lastTime.getTime() / 1000),
          600,
        );
        dateRangeStr = ` (${formatDateTimeRange(firstZoned, lastZoned, true)})`;
      }
      return `Synced ${synced.toLocaleString()} point_readings${dateRangeStr}`;
    },
  });

  // Update sync_status with the last synced timestamp
  if (result.lastBatchTime !== null && result.lastBatchTime !== undefined) {
    await updateSyncStatus(ctx, "point_readings", result.lastBatchTime);
  }

  return {
    detail: result.detail,
    context: { synced: result.synced },
  };
}

// Stage 12: Finalise - cleanup and verification
async function finaliseSync(ctx: SyncContext) {
  // Close the production database connection
  if (ctx.prodDb) {
    await ctx.prodDb.close();
  }

  const systemCount = await ctx.db.select().from(systems);

  // Add completion message followed by blank lines for scrolling
  ctx.updateStage("finalise", {
    detail: "Complete",
  });

  ctx.updateStage("finalise", {
    detail: "\u00A0", // Non-breaking space for blank line
  });

  ctx.updateStage("finalise", {
    detail: "\u00A0\u00A0", // Two non-breaking spaces for second blank line
  });

  return {};
}

// Export the stage definitions
export const syncStages: StageDefinition[] = [
  {
    id: "prepare",
    name: "Prepare for sync",
    modifiesMetadata: false,
    execute: prepareForSync,
  },
  {
    id: "sync-systems",
    name: "Sync systems",
    modifiesMetadata: true,
    execute: syncSystems,
  },
  {
    id: "sync-user-systems",
    name: "Sync user systems",
    modifiesMetadata: true,
    execute: syncUserSystems,
  },
  {
    id: "sync-point-info",
    name: "Sync point info",
    modifiesMetadata: true,
    execute: syncPointInfo,
  },
  {
    id: "count-records-to-sync",
    name: "Count all readings records to sync",
    modifiesMetadata: false,
    execute: countRecordsToSync,
  },
  {
    id: "sync-sessions",
    name: "Sync sessions",
    modifiesMetadata: false,
    execute: syncSessions,
  },
  {
    id: "sync-readings",
    name: "Sync solar system readings",
    modifiesMetadata: false,
    execute: syncReadings,
  },
  {
    id: "sync-5min-agg",
    name: "Sync 5-min solar systems reading aggregations",
    modifiesMetadata: false,
    execute: sync5MinAggregations,
  },
  {
    id: "sync-daily-agg",
    name: "Sync daily solar systems reading aggregations",
    modifiesMetadata: false,
    execute: syncDailyAggregations,
  },
  {
    id: "sync-point-readings",
    name: "Sync point readings",
    modifiesMetadata: false,
    execute: syncPointReadings,
  },
  {
    id: "sync-point-5min-agg",
    name: "Sync 5-min point reading aggregations",
    modifiesMetadata: false,
    execute: syncPointReadings5MinAggregations,
  },
  {
    id: "sync-point-daily-agg",
    name: "Sync daily point reading aggregations",
    modifiesMetadata: false,
    execute: syncPointDailyAggregations,
  },
  {
    id: "finalise",
    name: "Finalise",
    modifiesMetadata: false,
    execute: finaliseSync,
  },
];
