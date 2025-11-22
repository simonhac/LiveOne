import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { rawClient } from "@/lib/db";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { jsonResponse } from "@/lib/json";
import { kv } from "@vercel/kv";

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
    // This should match the logic in lib/db/index.ts
    const isProduction = process.env.NODE_ENV === "production";
    const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const isTursoUrl = databaseUrl.startsWith("libsql://");

    // Check if we're using Turso (production) or SQLite (development)
    // Match the logic from lib/db/index.ts: use Turso if URL starts with libsql:// OR in production
    const isUsingTurso = isTursoUrl || isProduction;

    // Mask sensitive parts of the database URL
    const maskedUrl = (() => {
      if (isUsingTurso && tursoUrl) {
        // For Turso URLs: libsql://database-name-user.region.turso.io
        const parts = tursoUrl.split(".");
        if (parts.length >= 3) {
          const dbPart = parts[0].split("//")[1];
          const maskedDb = dbPart.substring(0, 8) + "...";
          return `libsql://${maskedDb}.${parts[1]}.turso.io`;
        }
        return "libsql://*****.turso.io";
      } else {
        // For SQLite
        return databaseUrl.replace(/\/([^\/]+)$/, "/***");
      }
    })();

    // Get database statistics for all tables in a single query
    let stats = null;
    try {
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

      const tableStats = (result.rows as unknown as TableStat[]).map((row) => {
        // Convert timestamps to Unix milliseconds for jsonifier
        // point_info.created and updated_at store timestamps as Unix milliseconds
        // point_readings.received_time stores timestamps as Unix milliseconds
        // point_readings_agg_5m stores timestamps as Unix milliseconds
        // ALL other tables store timestamps as Unix seconds

        const toMilliseconds = (
          val: number | null,
          tableName: string,
        ): number | null => {
          if (!val) return null;

          // Point tables and point_readings use milliseconds
          if (
            tableName === "point_info" ||
            tableName === "point_readings" ||
            tableName === "point_readings_agg_5m"
          ) {
            return val as number;
          }

          // All other tables store timestamps as Unix seconds
          return (val as number) * 1000;
        };

        return {
          name: row.table_name,
          count: row.count,
          createdAtMinTimeMs: toMilliseconds(
            row.created_at_min,
            row.table_name,
          ),
          createdAtMaxTimeMs: toMilliseconds(
            row.created_at_max,
            row.table_name,
          ),
          updatedAtMinTimeMs: toMilliseconds(
            row.updated_at_min,
            row.table_name,
          ),
          updatedAtMaxTimeMs: toMilliseconds(
            row.updated_at_max,
            row.table_name,
          ),
        };
      });

      // Merge size data from KV cache if available (calculated outside this try block)
      stats = { tableStats };
    } catch (err) {
      console.error("Error fetching database stats:", err);
    }

    // Check if sync_status table exists and has entries (development only)
    let hasSyncStatus = false;
    if (!isUsingTurso) {
      try {
        const syncStatusResult = await rawClient.execute(
          `SELECT COUNT(*) as count FROM sync_status`,
        );
        hasSyncStatus = (syncStatusResult.rows[0]?.count as number) > 0;
      } catch (err) {
        // Table might not exist, that's fine
        hasSyncStatus = false;
      }
    }

    // Get table size data from KV cache
    let sizeData: {
      timestamp: number;
      sizes: Record<string, { dataMb: number; indexesMb: number }>;
    } | null = null;
    try {
      sizeData = await kv.get("db:stats:sizes");
    } catch (err) {
      console.error("Error fetching size data from KV:", err);
    }

    // Merge size data into table stats
    if (stats && sizeData) {
      stats.tableStats = stats.tableStats.map((tableStat) => {
        const sizeInfo = sizeData.sizes[tableStat.name];
        return {
          ...tableStat,
          dataSizeMb: sizeInfo?.dataMb ?? null,
          indexSizeMb: sizeInfo?.indexesMb ?? null,
        };
      });
    }

    // Calculate per-day metrics from last 30 days of snapshots
    let growthData: Record<
      string,
      {
        recordsPerDay: number | null;
        dataMbPerDay: number | null;
        indexMbPerDay: number | null;
        totalMbPerDay: number | null;
        daysInPeriod: number;
        using30DayWindow: boolean;
      }
    > = {};

    if (stats) {
      for (const tableStat of stats.tableStats) {
        try {
          // Get last 30 days of snapshots for this table
          const snapshotsResult = await rawClient.execute({
            sql: `
              SELECT
                snapshot_date,
                record_count,
                data_mb,
                index_mb
              FROM db_growth_snapshots
              WHERE table_name = ?
              ORDER BY snapshot_date DESC
              LIMIT 30
            `,
            args: [tableStat.name],
          });

          const snapshots = snapshotsResult.rows as any[];

          if (snapshots.length >= 2) {
            // We need at least 2 snapshots to calculate growth
            const oldestSnapshot = snapshots[snapshots.length - 1];
            const newestSnapshot = snapshots[0];

            // Calculate deltas
            const recordsDelta =
              newestSnapshot.record_count - oldestSnapshot.record_count;
            const dataMbDelta = newestSnapshot.data_mb - oldestSnapshot.data_mb;
            const indexMbDelta =
              newestSnapshot.index_mb - oldestSnapshot.index_mb;

            // Calculate days between snapshots
            const oldestDate = new Date(oldestSnapshot.snapshot_date);
            const newestDate = new Date(newestSnapshot.snapshot_date);
            const daysDiff = Math.max(
              1,
              Math.round(
                (newestDate.getTime() - oldestDate.getTime()) /
                  (1000 * 60 * 60 * 24),
              ),
            );

            // Calculate per-day averages
            growthData[tableStat.name] = {
              recordsPerDay: Math.round((recordsDelta / daysDiff) * 10) / 10,
              dataMbPerDay: Math.round((dataMbDelta / daysDiff) * 1000) / 1000,
              indexMbPerDay:
                Math.round((indexMbDelta / daysDiff) * 1000) / 1000,
              totalMbPerDay:
                Math.round(((dataMbDelta + indexMbDelta) / daysDiff) * 1000) /
                1000,
              daysInPeriod: daysDiff,
              using30DayWindow: snapshots.length === 30,
            };
          } else {
            // Not enough data
            growthData[tableStat.name] = {
              recordsPerDay: null,
              dataMbPerDay: null,
              indexMbPerDay: null,
              totalMbPerDay: null,
              daysInPeriod: snapshots.length,
              using30DayWindow: false,
            };
          }
        } catch (err) {
          console.error(`Error calculating growth for ${tableStat.name}:`, err);
          growthData[tableStat.name] = {
            recordsPerDay: null,
            dataMbPerDay: null,
            indexMbPerDay: null,
            totalMbPerDay: null,
            daysInPeriod: 0,
            using30DayWindow: false,
          };
        }
      }
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
        dbSizesCachedTimeMs: sizeData ? sizeData.timestamp : null,
      };
    } catch (err) {
      console.error("Error fetching cache info:", err);
    }

    // Merge growth data into table stats
    if (stats) {
      stats.tableStats = stats.tableStats.map((tableStat) => ({
        ...tableStat,
        growth: growthData[tableStat.name] || null,
      }));
    }

    // Prepare response
    const response = {
      success: true,
      database: {
        type: isUsingTurso ? ("production" as const) : ("development" as const),
        provider: isUsingTurso ? "Turso (LibSQL)" : "SQLite",
        stats,
        hasSyncStatus, // Whether automatic sync is available
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
