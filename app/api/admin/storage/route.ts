import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { rawClient } from "@/lib/db";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { jsonResponse } from "@/lib/json";

export async function GET(request: NextRequest) {
  try {
    // In development, allow bypass with X-Claude header
    const isDev = process.env.NODE_ENV === "development";
    const claudeHeader = request.headers.get("x-claude");
    const bypassAuth = isDev && claudeHeader === "true";

    let userId: string | null = null;

    if (!bypassAuth) {
      // Check if user is authenticated
      const auth_result = await auth();
      userId = auth_result.userId;

      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Check if user is admin - pass userId to avoid duplicate auth() call
      const isAdmin = await isUserAdmin(userId);

      if (!isAdmin) {
        return NextResponse.json(
          { error: "Admin access required" },
          { status: 403 },
        );
      }
    }

    // Determine database type based on environment variables
    const isProduction = process.env.NODE_ENV === "production";
    const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const isTursoUrl = databaseUrl.startsWith("libsql://");
    const isUsingTurso = isTursoUrl || isProduction;

    // Check if sync_status table exists and has entries (development only)
    let hasSyncStatus = false;
    if (!isUsingTurso) {
      try {
        const syncStatusResult = await rawClient.execute(
          `SELECT COUNT(*) as count FROM sync_status`,
        );
        hasSyncStatus = (syncStatusResult.rows[0]?.count as number) > 0;
      } catch {
        hasSyncStatus = false;
      }
    }

    // Try to get pre-computed stats from the latest snapshot
    let stats = null;
    let statsComputedTimeMs: number | null = null;

    try {
      // Get the latest snapshot (most recent date + hour)
      const snapshotResult = await rawClient.execute(`
        SELECT * FROM db_growth_snapshots
        WHERE (snapshot_date, COALESCE(snapshot_hour, 0)) = (
          SELECT snapshot_date, COALESCE(snapshot_hour, 0)
          FROM db_growth_snapshots
          ORDER BY snapshot_date DESC, COALESCE(snapshot_hour, 0) DESC
          LIMIT 1
        )
        ORDER BY record_count DESC
      `);

      if (snapshotResult.rows.length > 0) {
        // Check if the new columns are populated (created_at_min not null indicates migration ran)
        const firstRow = snapshotResult.rows[0] as any;
        const hasPrecomputedData =
          firstRow.created_at_min !== null || firstRow.records_per_day !== null;

        if (hasPrecomputedData) {
          // Use pre-computed data from snapshot
          const tableStats = snapshotResult.rows.map((row: any) => ({
            name: row.table_name,
            count: row.record_count,
            createdAtMinTimeMs: row.created_at_min,
            createdAtMaxTimeMs: row.created_at_max,
            updatedAtMinTimeMs: row.updated_at_min,
            updatedAtMaxTimeMs: row.updated_at_max,
            dataSizeMb: row.data_mb,
            indexSizeMb: row.index_mb,
            growth: {
              recordsPerDay: row.records_per_day,
              dataMbPerDay: row.data_mb_per_day,
              indexMbPerDay: row.index_mb_per_day,
              totalMbPerDay: row.total_mb_per_day,
              daysInPeriod: row.growth_days ?? 0,
              using30DayWindow: row.growth_days === 30,
            },
          }));

          stats = { tableStats };
          statsComputedTimeMs = firstRow.created_at;
        }
      }
    } catch (err) {
      console.error("Error fetching pre-computed stats:", err);
    }

    // Fallback: If no pre-computed data, calculate at runtime (slower)
    if (!stats) {
      console.log(
        "[Storage API] No pre-computed data, falling back to runtime calculation",
      );
      stats = await calculateStatsAtRuntime();
    }

    // Get cache refresh times from managers
    let cacheInfo = null;
    try {
      const systemsStatus = SystemsManager.getCacheStatus();
      const pointsStatus = PointManager.getCacheStatus();

      cacheInfo = {
        systemsManagerLoadedTimeMs:
          systemsStatus.lastLoadedAt > 0 ? systemsStatus.lastLoadedAt : null,
        pointManagerLoadedTimeMs:
          pointsStatus.lastLoadedAt > 0 ? pointsStatus.lastLoadedAt : null,
        statsComputedTimeMs,
      };
    } catch (err) {
      console.error("Error fetching cache info:", err);
    }

    // Prepare response
    const response = {
      success: true,
      database: {
        type: isUsingTurso ? ("production" as const) : ("development" as const),
        provider: isUsingTurso ? "Turso (LibSQL)" : "SQLite",
        stats,
        hasSyncStatus,
      },
      cacheInfo,
      environment: {
        nodeEnv: process.env.NODE_ENV || "development",
        vercelEnv: process.env.VERCEL_ENV,
        region: process.env.VERCEL_REGION,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID?.substring(0, 8) + "...",
      },
    };

    return jsonResponse(response);
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch settings",
      },
      { status: 500 },
    );
  }
}

/**
 * Fallback: Calculate stats at runtime if pre-computed data is not available.
 * This is slower but ensures the page works even before the cron job runs.
 */
async function calculateStatsAtRuntime() {
  // Get record counts and timestamp ranges for all tables
  const result = await rawClient.execute(`
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

  const tableStats = (result.rows as unknown as TableStat[]).map((row) => ({
    name: row.table_name,
    count: row.count,
    createdAtMinTimeMs: toMilliseconds(row.created_at_min, row.table_name),
    createdAtMaxTimeMs: toMilliseconds(row.created_at_max, row.table_name),
    updatedAtMinTimeMs: toMilliseconds(row.updated_at_min, row.table_name),
    updatedAtMaxTimeMs: toMilliseconds(row.updated_at_max, row.table_name),
    dataSizeMb: null as number | null,
    indexSizeMb: null as number | null,
    growth: null as {
      recordsPerDay: number | null;
      dataMbPerDay: number | null;
      indexMbPerDay: number | null;
      totalMbPerDay: number | null;
      daysInPeriod: number;
      using30DayWindow: boolean;
    } | null,
  }));

  // Try to get size and growth data from snapshots
  for (const tableStat of tableStats) {
    try {
      // Get latest snapshot for this table (may have size data even without new columns)
      const latestSnapshot = await rawClient.execute({
        sql: `SELECT data_mb, index_mb, records_per_day, data_mb_per_day, index_mb_per_day, total_mb_per_day, growth_days
              FROM db_growth_snapshots
              WHERE table_name = ?
              ORDER BY snapshot_date DESC
              LIMIT 1`,
        args: [tableStat.name],
      });

      if (latestSnapshot.rows.length > 0) {
        const snap = latestSnapshot.rows[0] as any;
        tableStat.dataSizeMb = snap.data_mb;
        tableStat.indexSizeMb = snap.index_mb;

        // If growth data is pre-computed, use it
        if (snap.records_per_day !== null) {
          tableStat.growth = {
            recordsPerDay: snap.records_per_day,
            dataMbPerDay: snap.data_mb_per_day,
            indexMbPerDay: snap.index_mb_per_day,
            totalMbPerDay: snap.total_mb_per_day,
            daysInPeriod: snap.growth_days ?? 0,
            using30DayWindow: snap.growth_days === 30,
          };
        } else {
          // Calculate growth from historical snapshots
          tableStat.growth = await calculateGrowthFromSnapshots(tableStat.name);
        }
      }
    } catch (err) {
      console.error(`Error getting snapshot data for ${tableStat.name}:`, err);
    }
  }

  return { tableStats };
}

/**
 * Calculate growth rate from historical snapshots (fallback when not pre-computed)
 */
async function calculateGrowthFromSnapshots(tableName: string) {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const currentHour = now.getUTCHours();

  // Target: 30 days ago at the same hour
  const targetDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const targetDateStr = targetDate.toISOString().split("T")[0];
  const targetHour = targetDate.getUTCHours();

  // Find snapshot closest to exactly 30 days ago
  const oldSnapshot = await rawClient.execute({
    sql: `SELECT record_count, data_mb, index_mb, snapshot_date, snapshot_hour,
            ABS(
              (julianday(snapshot_date) + COALESCE(snapshot_hour, 0)/24.0) -
              (julianday(?) + ?/24.0)
            ) as distance
          FROM db_growth_snapshots
          WHERE table_name = ?
          ORDER BY distance ASC
          LIMIT 1`,
    args: [targetDateStr, targetHour, tableName],
  });

  // Get today's/latest snapshot
  const todaySnapshot = await rawClient.execute({
    sql: `SELECT record_count, data_mb, index_mb, snapshot_date, snapshot_hour
          FROM db_growth_snapshots
          WHERE table_name = ?
          ORDER BY snapshot_date DESC, COALESCE(snapshot_hour, 0) DESC
          LIMIT 1`,
    args: [tableName],
  });

  if (oldSnapshot.rows.length > 0 && todaySnapshot.rows.length > 0) {
    const old = oldSnapshot.rows[0] as any;
    const current = todaySnapshot.rows[0] as any;

    // Calculate precise time difference
    const oldHour = old.snapshot_hour ?? 0;
    const currentSnapshotHour = current.snapshot_hour ?? currentHour;
    const oldTime = new Date(
      `${old.snapshot_date}T${oldHour.toString().padStart(2, "0")}:00:00Z`,
    );
    const currentTime = new Date(
      `${current.snapshot_date}T${currentSnapshotHour.toString().padStart(2, "0")}:00:00Z`,
    );

    const hoursDiff =
      (currentTime.getTime() - oldTime.getTime()) / (1000 * 60 * 60);
    const daysDiff = Math.max(0.5, hoursDiff / 24);

    // Calculate deltas
    const recordsDelta = current.record_count - old.record_count;
    const dataMbDelta = current.data_mb - old.data_mb;
    const indexMbDelta = current.index_mb - old.index_mb;

    return {
      recordsPerDay: Math.round((recordsDelta / daysDiff) * 10) / 10,
      dataMbPerDay: Math.round((dataMbDelta / daysDiff) * 1000) / 1000,
      indexMbPerDay: Math.round((indexMbDelta / daysDiff) * 1000) / 1000,
      totalMbPerDay:
        Math.round(((dataMbDelta + indexMbDelta) / daysDiff) * 1000) / 1000,
      daysInPeriod: Math.round(daysDiff * 10) / 10,
      using30DayWindow: Math.abs(daysDiff - 30) <= 0.5,
    };
  }

  return {
    recordsPerDay: null,
    dataMbPerDay: null,
    indexMbPerDay: null,
    totalMbPerDay: null,
    daysInPeriod: 0,
    using30DayWindow: false,
  };
}

export async function POST(request: NextRequest) {
  try {
    // In development, allow bypass with X-Claude header
    const isDev = process.env.NODE_ENV === "development";
    const claudeHeader = request.headers.get("x-claude");
    const bypassAuth = isDev && claudeHeader === "true";

    if (!bypassAuth) {
      // Check if user is authenticated
      const auth_result = await auth();
      const userId = auth_result.userId;

      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Check if user is admin
      const isAdmin = await isUserAdmin(userId);

      if (!isAdmin) {
        return NextResponse.json(
          { error: "Admin access required" },
          { status: 403 },
        );
      }
    }

    // Parse request body
    const body = await request.json();
    const { action } = body;

    if (action === "force-reload-caches") {
      // Clear both cache instances to force reload on next access
      SystemsManager.invalidateCache();
      PointManager.invalidateCache();

      return NextResponse.json({
        success: true,
        message: "Caches cleared successfully",
      });
    }

    return NextResponse.json(
      { success: false, error: "Unknown action" },
      { status: 400 },
    );
  } catch (error) {
    console.error("Error handling POST request:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to process request",
      },
      { status: 500 },
    );
  }
}
