import { NextRequest, NextResponse } from "next/server";
import { validateCronRequest } from "@/lib/cron-utils";
import { rawClient } from "@/lib/db";

// Force Node.js runtime (required for long-running operations)
export const runtime = "nodejs";
export const maxDuration = 180; // 3 minutes

/**
 * Database size statistics cron job
 * Calculates table and index sizes, timestamp ranges, and growth rates
 * Stores all pre-computed values in db_growth_snapshots
 *
 * Auth: Cron secret, admin users, or x-claude header in development
 * Returns: The calculated statistics (so admin can see immediate feedback)
 *
 * Runs: Twice daily at 02:00 and 14:00 UTC (12pm/12am AEST)
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

  console.log("[DB Stats Cron] Starting database statistics calculation...");

  try {
    // 1. Query database for table and index sizes
    // This is an expensive operation (~2 minutes) but runs in background
    console.log("[DB Stats Cron] Calculating table sizes via dbstat...");
    const sizeResult = await rawClient.execute(`
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

    interface SizeRow {
      table_name: string;
      data_mb: number;
      indexes_mb: number;
    }

    const sizeMap: Record<string, { dataMb: number; indexesMb: number }> = {};
    for (const row of sizeResult.rows as unknown as SizeRow[]) {
      sizeMap[row.table_name] = {
        dataMb: row.data_mb,
        indexesMb: row.indexes_mb,
      };
    }

    // 2. Get record counts and timestamp ranges for all tables
    console.log(
      "[DB Stats Cron] Calculating record counts and timestamp ranges...",
    );
    const statsResult = await rawClient.execute(`
      SELECT 'systems' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
      FROM systems
      UNION ALL
      SELECT 'readings' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        NULL as updated_at_min, NULL as updated_at_max
      FROM readings
      UNION ALL
      SELECT 'polling_status' as table_name, COUNT(*) as count,
        NULL as created_at_min, NULL as created_at_max,
        MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
      FROM polling_status
      UNION ALL
      SELECT 'readings_agg_5m' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        NULL as updated_at_min, NULL as updated_at_max
      FROM readings_agg_5m
      UNION ALL
      SELECT 'readings_agg_1d' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
      FROM readings_agg_1d
      UNION ALL
      SELECT 'user_systems' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
      FROM user_systems
      UNION ALL
      SELECT 'sessions' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        NULL as updated_at_min, NULL as updated_at_max
      FROM sessions
      UNION ALL
      SELECT 'point_info' as table_name, COUNT(*) as count,
        MIN(created) as created_at_min, MAX(created) as created_at_max,
        MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
      FROM point_info
      UNION ALL
      SELECT 'point_readings' as table_name, COUNT(*) as count,
        MIN(received_time) as created_at_min, MAX(received_time) as created_at_max,
        NULL as updated_at_min, NULL as updated_at_max
      FROM point_readings
      UNION ALL
      SELECT 'point_readings_agg_5m' as table_name, COUNT(*) as count,
        MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
        MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
      FROM point_readings_agg_5m
    `);

    interface TableStat {
      table_name: string;
      count: number;
      created_at_min: number | null;
      created_at_max: number | null;
      updated_at_min: number | null;
      updated_at_max: number | null;
    }

    // Convert timestamps to milliseconds based on table conventions
    const toMilliseconds = (
      val: number | null,
      tableName: string,
    ): number | null => {
      if (!val) return null;
      // Point tables store timestamps as Unix milliseconds
      if (
        tableName === "point_info" ||
        tableName === "point_readings" ||
        tableName === "point_readings_agg_5m"
      ) {
        return val;
      }
      // All other tables store timestamps as Unix seconds
      return val * 1000;
    };

    const tableStats: Record<
      string,
      {
        count: number;
        createdAtMin: number | null;
        createdAtMax: number | null;
        updatedAtMin: number | null;
        updatedAtMax: number | null;
      }
    > = {};

    for (const row of statsResult.rows as unknown as TableStat[]) {
      tableStats[row.table_name] = {
        count: row.count,
        createdAtMin: toMilliseconds(row.created_at_min, row.table_name),
        createdAtMax: toMilliseconds(row.created_at_max, row.table_name),
        updatedAtMin: toMilliseconds(row.updated_at_min, row.table_name),
        updatedAtMax: toMilliseconds(row.updated_at_max, row.table_name),
      };
    }

    // 3. Calculate growth rates for each table
    console.log("[DB Stats Cron] Calculating growth rates...");
    const today = new Date().toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const growthData: Record<
      string,
      {
        recordsPerDay: number | null;
        dataMbPerDay: number | null;
        indexMbPerDay: number | null;
        totalMbPerDay: number | null;
        growthDays: number | null;
      }
    > = {};

    for (const tableName of Object.keys(tableStats)) {
      // Try to find snapshot from exactly 30 days ago
      let oldSnapshot = await rawClient.execute({
        sql: `SELECT record_count, data_mb, index_mb, snapshot_date
              FROM db_growth_snapshots
              WHERE table_name = ? AND snapshot_date = ?`,
        args: [tableName, thirtyDaysAgo],
      });

      // If not found, get nearest snapshot (at least 25 days ago for reasonable growth calc)
      if (oldSnapshot.rows.length === 0) {
        oldSnapshot = await rawClient.execute({
          sql: `SELECT record_count, data_mb, index_mb, snapshot_date
                FROM db_growth_snapshots
                WHERE table_name = ? AND snapshot_date <= ?
                ORDER BY snapshot_date DESC
                LIMIT 1`,
          args: [tableName, thirtyDaysAgo],
        });
      }

      if (oldSnapshot.rows.length > 0) {
        const old = oldSnapshot.rows[0] as any;
        const current = tableStats[tableName];
        const sizes = sizeMap[tableName];

        // Calculate days between snapshots
        const oldDate = new Date(old.snapshot_date);
        const todayDate = new Date(today);
        const daysDiff = Math.max(
          1,
          Math.round(
            (todayDate.getTime() - oldDate.getTime()) / (1000 * 60 * 60 * 24),
          ),
        );

        // Calculate deltas
        const recordsDelta = current.count - (old.record_count as number);
        const dataMbDelta = (sizes?.dataMb ?? 0) - (old.data_mb as number);
        const indexMbDelta = (sizes?.indexesMb ?? 0) - (old.index_mb as number);

        growthData[tableName] = {
          recordsPerDay: Math.round((recordsDelta / daysDiff) * 10) / 10,
          dataMbPerDay: Math.round((dataMbDelta / daysDiff) * 1000) / 1000,
          indexMbPerDay: Math.round((indexMbDelta / daysDiff) * 1000) / 1000,
          totalMbPerDay:
            Math.round(((dataMbDelta + indexMbDelta) / daysDiff) * 1000) / 1000,
          growthDays: daysDiff,
        };
      } else {
        // No historical data available
        growthData[tableName] = {
          recordsPerDay: null,
          dataMbPerDay: null,
          indexMbPerDay: null,
          totalMbPerDay: null,
          growthDays: null,
        };
      }
    }

    // 4. Store snapshots with all computed values
    console.log(
      "[DB Stats Cron] Storing snapshots with pre-computed values...",
    );
    let snapshotsInserted = 0;

    for (const tableName of Object.keys(tableStats)) {
      const stats = tableStats[tableName];
      const sizes = sizeMap[tableName];
      const growth = growthData[tableName];

      if (sizes && stats.count > 0) {
        // Determine if this is an exact 30-day calculation
        const isEstimated = growth.growthDays !== 30 ? 1 : 0;

        await rawClient.execute({
          sql: `
            INSERT INTO db_growth_snapshots
              (snapshot_date, table_name, record_count, data_mb, index_mb, is_estimated, created_at,
               created_at_min, created_at_max, updated_at_min, updated_at_max,
               records_per_day, data_mb_per_day, index_mb_per_day, total_mb_per_day, growth_days)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (snapshot_date, table_name)
            DO UPDATE SET
              record_count = excluded.record_count,
              data_mb = excluded.data_mb,
              index_mb = excluded.index_mb,
              is_estimated = excluded.is_estimated,
              created_at = excluded.created_at,
              created_at_min = excluded.created_at_min,
              created_at_max = excluded.created_at_max,
              updated_at_min = excluded.updated_at_min,
              updated_at_max = excluded.updated_at_max,
              records_per_day = excluded.records_per_day,
              data_mb_per_day = excluded.data_mb_per_day,
              index_mb_per_day = excluded.index_mb_per_day,
              total_mb_per_day = excluded.total_mb_per_day,
              growth_days = excluded.growth_days
          `,
          args: [
            today,
            tableName,
            stats.count,
            sizes.dataMb,
            sizes.indexesMb,
            isEstimated,
            Date.now(),
            stats.createdAtMin,
            stats.createdAtMax,
            stats.updatedAtMin,
            stats.updatedAtMax,
            growth.recordsPerDay,
            growth.dataMbPerDay,
            growth.indexMbPerDay,
            growth.totalMbPerDay,
            growth.growthDays,
          ],
        });
        snapshotsInserted++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[DB Stats Cron] Completed in ${(duration / 1000).toFixed(1)}s. Stored ${snapshotsInserted} snapshots for ${today}.`,
    );

    return NextResponse.json({
      success: true,
      durationMs: duration,
      tableCount: Object.keys(sizeMap).length,
      snapshotsInserted,
      snapshotDate: today,
      timestamp: Date.now(),
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
