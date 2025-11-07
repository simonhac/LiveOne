import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { rawClient } from "@/lib/db";
import { isUserAdmin } from "@/lib/auth-utils";
import { fromDate } from "@internationalized/date";
import { formatTimeAEST } from "@/lib/date-utils";

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();

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
        SELECT 'systems' as table_name, COUNT(*) as count, NULL as earliest, NULL as latest FROM systems
        UNION ALL
        SELECT 'readings' as table_name, COUNT(*) as count, MIN(inverter_time) as earliest, MAX(inverter_time) as latest FROM readings
        UNION ALL
        SELECT 'polling_status' as table_name, COUNT(*) as count,
          MIN(COALESCE(last_poll_time, last_success_time, last_error_time)) as earliest,
          MAX(COALESCE(last_poll_time, last_success_time, last_error_time)) as latest
        FROM polling_status
        UNION ALL
        SELECT 'readings_agg_5m' as table_name, COUNT(*) as count, MIN(interval_end) as earliest, MAX(interval_end) as latest FROM readings_agg_5m
        UNION ALL
        SELECT 'readings_agg_1d' as table_name, COUNT(*) as count, MIN(day) as earliest, MAX(day) as latest FROM readings_agg_1d
        UNION ALL
        SELECT 'user_systems' as table_name, COUNT(*) as count, NULL as earliest, NULL as latest FROM user_systems
        UNION ALL
        SELECT 'sessions' as table_name, COUNT(*) as count, MIN(started) as earliest, MAX(started) as latest FROM sessions
        UNION ALL
        SELECT 'point_info' as table_name, COUNT(*) as count, MIN(created) as earliest, MAX(created) as latest FROM point_info
        UNION ALL
        SELECT 'point_readings' as table_name, COUNT(*) as count, MIN(measurement_time) as earliest, MAX(measurement_time) as latest FROM point_readings
        UNION ALL
        SELECT 'point_readings_agg_5m' as table_name, COUNT(*) as count, MIN(interval_end) as earliest, MAX(interval_end) as latest FROM point_readings_agg_5m
      `);

      interface TableStat {
        table_name: string;
        count: number;
        earliest: number | string | null;
        latest: number | string | null;
      }

      const tableStats = (result.rows as unknown as TableStat[]).map((row) => {
        // Return raw timestamps for frontend formatting
        // readings_agg_1d stores day as string (YYYY-MM-DD), return as-is
        // point_readings and point_readings_agg_5m store timestamps as Unix milliseconds
        // point_info.created stores timestamps as Unix milliseconds
        // ALL other tables store timestamps as Unix seconds

        const formatForFrontend = (
          val: number | string | null,
          tableName: string,
        ) => {
          if (!val) return undefined;

          if (tableName === "readings_agg_1d") {
            // Already a YYYY-MM-DD string
            return val as string;
          }

          // Point tables store milliseconds
          if (
            tableName === "point_readings" ||
            tableName === "point_readings_agg_5m" ||
            tableName === "point_info"
          ) {
            return new Date(val as number).toISOString();
          }

          // All other timestamps are stored as Unix seconds -> multiply by 1000 for milliseconds
          return new Date((val as number) * 1000).toISOString();
        };

        // Calculate records per day
        let recordsPerDay: number | null = null;
        if (row.earliest && row.latest && row.count > 0) {
          let earliestMs: number;
          let latestMs: number;

          if (row.table_name === "readings_agg_1d") {
            // Parse YYYY-MM-DD strings
            earliestMs = new Date(row.earliest as string).getTime();
            latestMs = new Date(row.latest as string).getTime();
          } else if (
            row.table_name === "point_readings" ||
            row.table_name === "point_readings_agg_5m" ||
            row.table_name === "point_info"
          ) {
            // Already in milliseconds
            earliestMs = row.earliest as number;
            latestMs = row.latest as number;
          } else {
            // Unix seconds -> convert to milliseconds
            earliestMs = (row.earliest as number) * 1000;
            latestMs = (row.latest as number) * 1000;
          }

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
          earliestTimestamp: formatForFrontend(row.earliest, row.table_name),
          latestTimestamp: formatForFrontend(row.latest, row.table_name),
          recordsPerDay: recordsPerDay,
        };
      });

      stats = { tableStats };
    } catch (err) {
      console.error("Error fetching database stats:", err);
    }

    // Prepare response
    const response = {
      success: true,
      database: {
        type: isUsingTurso ? ("production" as const) : ("development" as const),
        provider: isUsingTurso ? "Turso (LibSQL)" : "SQLite",
        stats,
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || "development",
        vercelEnv: process.env.VERCEL_ENV,
        region: process.env.VERCEL_REGION,
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID?.substring(0, 8) + "...",
      },
    };

    return NextResponse.json(response);
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
