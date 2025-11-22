import { NextRequest, NextResponse } from "next/server";
import { validateCronRequest } from "@/lib/cron-utils";
import { rawClient } from "@/lib/db";
import { kv } from "@vercel/kv";

// Force Node.js runtime (required for long-running operations)
export const runtime = "nodejs";
export const maxDuration = 180; // 3 minutes

/**
 * Database size statistics cron job
 * Calculates table and index sizes and stores in Vercel KV
 *
 * Auth: Cron secret, admin users, or x-claude header in development
 * Returns: The calculated statistics (so admin can see immediate feedback)
 *
 * Runs: Daily at midnight UTC (configured in vercel.json)
 * Duration: ~2 minutes (scans entire database via dbstat)
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // Validate authorization (cron secret, admin, or x-claude in dev)
  const isValid = await validateCronRequest(request);
  if (!isValid) {
    // In dev, also allow x-claude header
    const isDev = process.env.NODE_ENV === "development";
    const claudeHeader = request.headers.get("x-claude");

    if (!(isDev && claudeHeader === "true")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  console.log("[DB Stats Cron] Starting database size calculation...");

  try {
    // Query database for table and index sizes
    // This is an expensive operation (~2 minutes) but runs in background
    const result = await rawClient.execute(`
      WITH table_data AS (
        SELECT
          name as table_name,
          ROUND(SUM(pgsize) / 1024.0 / 1024.0, 2) as data_mb
        FROM dbstat
        WHERE name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '%_idx'
          AND name NOT LIKE '%_index'
          AND name NOT LIKE 'idx_%'
          AND name NOT LIKE '%unique%'
        GROUP BY name
      ),
      index_data AS (
        SELECT
          m.tbl_name as table_name,
          ROUND(SUM(d.pgsize) / 1024.0 / 1024.0, 2) as indexes_mb
        FROM sqlite_master m
        JOIN dbstat d ON d.name = m.name
        WHERE m.type = 'index'
          AND m.name NOT LIKE 'sqlite_%'
        GROUP BY m.tbl_name
      )
      SELECT
        COALESCE(t.table_name, i.table_name) as table_name,
        COALESCE(t.data_mb, 0) as data_mb,
        COALESCE(i.indexes_mb, 0) as indexes_mb
      FROM table_data t
      LEFT JOIN index_data i ON t.table_name = i.table_name
      ORDER BY table_name;
    `);

    // Format results as a map for easy lookup
    interface SizeRow {
      table_name: string;
      data_mb: number;
      indexes_mb: number;
    }

    const sizeMap: Record<string, { dataMb: number; indexesMb: number }> = {};
    for (const row of result.rows as unknown as SizeRow[]) {
      sizeMap[row.table_name] = {
        dataMb: row.data_mb,
        indexesMb: row.indexes_mb,
      };
    }

    const stats = {
      timestamp: Date.now(),
      sizes: sizeMap,
    };

    // Store in Vercel KV with 7-day expiration
    // (Daily cron will refresh, but keep a week in case cron fails)
    await kv.set("db:stats:sizes", stats, { ex: 7 * 24 * 60 * 60 });

    // Store daily snapshot for growth tracking
    // Get today's date in YYYY-MM-DD format (UTC)
    const today = new Date().toISOString().split("T")[0];

    console.log("[DB Stats Cron] Storing daily snapshots...");

    // Get record counts for all tables
    const countResult = await rawClient.execute(`
      SELECT 'systems' as table_name, COUNT(*) as count FROM systems
      UNION ALL SELECT 'readings' as table_name, COUNT(*) as count FROM readings
      UNION ALL SELECT 'readings_agg_5m' as table_name, COUNT(*) as count FROM readings_agg_5m
      UNION ALL SELECT 'readings_agg_1d' as table_name, COUNT(*) as count FROM readings_agg_1d
      UNION ALL SELECT 'user_systems' as table_name, COUNT(*) as count FROM user_systems
      UNION ALL SELECT 'sessions' as table_name, COUNT(*) as count FROM sessions
      UNION ALL SELECT 'point_info' as table_name, COUNT(*) as count FROM point_info
      UNION ALL SELECT 'point_readings' as table_name, COUNT(*) as count FROM point_readings
      UNION ALL SELECT 'point_readings_agg_5m' as table_name, COUNT(*) as count FROM point_readings_agg_5m
    `);

    // Insert snapshots for each table
    let snapshotsInserted = 0;
    for (const row of countResult.rows as any[]) {
      const tableName = row.table_name;
      const recordCount = row.count;
      const sizes = sizeMap[tableName];

      if (sizes && recordCount > 0) {
        await rawClient.execute({
          sql: `
            INSERT INTO db_growth_snapshots
              (snapshot_date, table_name, record_count, data_mb, index_mb, is_estimated, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT (snapshot_date, table_name)
            DO UPDATE SET
              record_count = excluded.record_count,
              data_mb = excluded.data_mb,
              index_mb = excluded.index_mb,
              is_estimated = 0,
              created_at = excluded.created_at
          `,
          args: [
            today,
            tableName,
            recordCount,
            sizes.dataMb,
            sizes.indexesMb,
            Date.now(),
          ],
        });
        snapshotsInserted++;
      }
    }

    console.log(
      `[DB Stats Cron] Stored ${snapshotsInserted} snapshots for ${today}`,
    );

    const duration = Date.now() - startTime;
    console.log(
      `[DB Stats Cron] Completed in ${(duration / 1000).toFixed(1)}s. Calculated sizes for ${Object.keys(sizeMap).length} tables.`,
    );

    return NextResponse.json({
      success: true,
      durationMs: duration,
      tableCount: Object.keys(sizeMap).length,
      snapshotsInserted,
      snapshotDate: today,
      timestamp: stats.timestamp,
      sizes: sizeMap,
    });
  } catch (error) {
    console.error("[DB Stats Cron] Error calculating database stats:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
