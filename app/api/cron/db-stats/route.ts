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

    const duration = Date.now() - startTime;
    console.log(
      `[DB Stats Cron] Completed in ${(duration / 1000).toFixed(1)}s. Calculated sizes for ${Object.keys(sizeMap).length} tables.`,
    );

    return NextResponse.json({
      success: true,
      durationMs: duration,
      tableCount: Object.keys(sizeMap).length,
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
