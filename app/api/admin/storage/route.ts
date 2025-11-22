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
        SELECT 'systems' as table_name, COUNT(*) as count, NULL as earliest, NULL as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
        FROM systems
        UNION ALL
        SELECT 'readings' as table_name, COUNT(*) as count, MIN(inverter_time) as earliest, MAX(inverter_time) as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          NULL as updated_at_min, NULL as updated_at_max
        FROM readings
        UNION ALL
        SELECT 'polling_status' as table_name, COUNT(*) as count,
          MIN(COALESCE(last_poll_time, last_success_time, last_error_time)) as earliest,
          MAX(COALESCE(last_poll_time, last_success_time, last_error_time)) as latest,
          NULL as created_at_min, NULL as created_at_max,
          MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
        FROM polling_status
        UNION ALL
        SELECT 'readings_agg_5m' as table_name, COUNT(*) as count, MIN(interval_end) as earliest, MAX(interval_end) as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          NULL as updated_at_min, NULL as updated_at_max
        FROM readings_agg_5m
        UNION ALL
        SELECT 'readings_agg_1d' as table_name, COUNT(*) as count, MIN(day) as earliest, MAX(day) as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
        FROM readings_agg_1d
        UNION ALL
        SELECT 'user_systems' as table_name, COUNT(*) as count, NULL as earliest, NULL as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
        FROM user_systems
        UNION ALL
        SELECT 'sessions' as table_name, COUNT(*) as count, MIN(started) as earliest, MAX(started) as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          NULL as updated_at_min, NULL as updated_at_max
        FROM sessions
        UNION ALL
        SELECT 'point_info' as table_name, COUNT(*) as count, MIN(created) as earliest, MAX(created) as latest,
          MIN(created) as created_at_min, MAX(created) as created_at_max,
          MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
        FROM point_info
        UNION ALL
        SELECT 'point_readings' as table_name, COUNT(*) as count, MIN(measurement_time) as earliest, MAX(measurement_time) as latest,
          NULL as created_at_min, NULL as created_at_max,
          NULL as updated_at_min, NULL as updated_at_max
        FROM point_readings
        UNION ALL
        SELECT 'point_readings_agg_5m' as table_name, COUNT(*) as count, MIN(interval_end) as earliest, MAX(interval_end) as latest,
          MIN(created_at) as created_at_min, MAX(created_at) as created_at_max,
          MIN(updated_at) as updated_at_min, MAX(updated_at) as updated_at_max
        FROM point_readings_agg_5m
      `);

      interface TableStat {
        table_name: string;
        count: number;
        earliest: number | string | null;
        latest: number | string | null;
        created_at_min: number | null;
        created_at_max: number | null;
        updated_at_min: number | null;
        updated_at_max: number | null;
      }

      const tableStats = (result.rows as unknown as TableStat[]).map((row) => {
        // Convert timestamps to Unix milliseconds for jsonifier
        // readings_agg_1d stores day as string (YYYY-MM-DD), return as-is for earliest/latest
        // point_readings and point_readings_agg_5m store timestamps as Unix milliseconds
        // point_info.created and updated_at store timestamps as Unix milliseconds
        // ALL other tables store timestamps as Unix seconds

        const toMilliseconds = (
          val: number | string | null,
          tableName: string,
          fieldType: "data" | "metadata",
        ): number | null => {
          if (!val) return null;

          // For data timestamps (earliest/latest)
          if (fieldType === "data") {
            if (tableName === "readings_agg_1d") {
              // Parse YYYY-MM-DD string to milliseconds
              return new Date(val as string).getTime();
            }

            // Point tables store milliseconds
            if (
              tableName === "point_readings" ||
              tableName === "point_readings_agg_5m" ||
              tableName === "point_info"
            ) {
              return val as number;
            }

            // All other data timestamps are stored as Unix seconds
            return (val as number) * 1000;
          }

          // For metadata timestamps (created_at, updated_at)
          // Point tables use milliseconds, others use seconds
          if (
            tableName === "point_info" ||
            tableName === "point_readings_agg_5m"
          ) {
            return val as number;
          }

          // All other metadata timestamps are Unix seconds
          return (val as number) * 1000;
        };

        // Calculate records per day
        let recordsPerDay: number | null = null;
        const earliestMs = toMilliseconds(row.earliest, row.table_name, "data");
        const latestMs = toMilliseconds(row.latest, row.table_name, "data");

        if (earliestMs && latestMs && row.count > 0) {
          const durationMs = latestMs - earliestMs;
          const durationDays = durationMs / (1000 * 60 * 60 * 24);

          // Avoid division by zero - if timestamps are the same, treat as 1 day
          if (durationDays > 0) {
            recordsPerDay = row.count / durationDays;
          } else {
            recordsPerDay = row.count;
          }
        }

        return {
          name: row.table_name,
          count: row.count,
          createdAtMinTimeMs: toMilliseconds(
            row.created_at_min,
            row.table_name,
            "metadata",
          ),
          createdAtMaxTimeMs: toMilliseconds(
            row.created_at_max,
            row.table_name,
            "metadata",
          ),
          updatedAtMinTimeMs: toMilliseconds(
            row.updated_at_min,
            row.table_name,
            "metadata",
          ),
          updatedAtMaxTimeMs: toMilliseconds(
            row.updated_at_max,
            row.table_name,
            "metadata",
          ),
          earliestTimeMs: earliestMs,
          latestTimeMs: latestMs,
          recordsPerDay: recordsPerDay,
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
