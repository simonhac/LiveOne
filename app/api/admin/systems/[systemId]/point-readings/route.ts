import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { eq, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { PointInfo } from "@/lib/point/point-info";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { fetchAdminPivotRowsPg } from "@/lib/db/planetscale/readings-read-pg";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo as pgPointInfo } from "@/lib/db/planetscale/schema";

/** Run a raw read against Postgres and return its rows. */
async function pgRows(query: string): Promise<unknown[]> {
  const res = await requirePlanetscaleDb().execute(sql.raw(query));
  return ((res as { rows?: unknown[] }).rows ?? []) as unknown[];
}

/**
 * Apply transform to a numeric value based on the transform type
 * - null or 'n': no transform (return original value)
 * - 'i': invert (multiply by -1)
 */
function applyTransform(
  value: number | null,
  transform: string | null,
): number | null {
  if (value === null) return null;
  if (!transform || transform === "n") return value;
  if (transform === "i") return -value;
  return value;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "200"), 1000);
    const source = searchParams.get("source") || "raw"; // "raw", "5m", or "daily"
    const cursorParam = searchParams.get("cursor"); // ISO8601 string for raw/5m, YYYY-MM-DD for daily
    const direction = searchParams.get("direction") || "newer"; // "older" or "newer"

    // Track database elapsed time
    let dbElapsedMs = 0;

    // Get system from SystemsManager (already cached in memory)
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Convert cursor to database format (millisecond timestamp for raw/5m, YYYY-MM-DD for daily)
    let cursor: number | string | null = null;
    if (cursorParam) {
      if (source === "daily") {
        cursor = cursorParam; // Already YYYY-MM-DD, use directly
      } else {
        // Parse ISO8601 to Unix timestamp milliseconds
        cursor = new Date(cursorParam).getTime();
      }
    }

    // Get username from system owner
    let username: string | null = null;
    if (system.ownerClerkUserId) {
      try {
        const clerk = await clerkClient();
        const owner = await clerk.users.getUser(system.ownerClerkUserId);
        username = owner.username || null;
      } catch (error) {
        console.error("Error fetching owner username:", error);
      }
    }

    // Get all point info for this system
    const pointsStartTime = Date.now();
    const pgPoints = await requirePlanetscaleDb()
      .select()
      .from(pgPointInfo)
      .where(eq(pgPointInfo.systemId, systemId))
      .orderBy(pgPointInfo.index);
    // Map PG rows (native timestamps) to the served shape (epoch-ms columns) the rest
    // of this route consumes.
    const points = pgPoints.map((p) => ({
      ...p,
      createdAtMs: p.createdAt ? p.createdAt.getTime() : 0,
      updatedAtMs: p.updatedAt ? p.updatedAt.getTime() : null,
    }));
    dbElapsedMs += Date.now() - pointsStartTime;

    if (points.length === 0) {
      return NextResponse.json({
        headers: [],
        data: [],
        metadata: {
          systemId,
          systemShortName: system.alias || null,
          ownerUsername: username,
          timezoneOffsetMin: system.timezoneOffsetMin,
          pointCount: 0,
          rowCount: 0,
          dbElapsedMs,
        },
      });
    }

    // Sort points: active points with logical path first, then inactive, then no logical path
    const sortedPoints = [...points].sort((a, b) => {
      const aHasPath = !!a.logicalPathStem;
      const bHasPath = !!b.logicalPathStem;

      // Active points with logical path come first
      if (aHasPath && a.active && !(bHasPath && b.active)) return -1;
      if (bHasPath && b.active && !(aHasPath && a.active)) return 1;

      // Both are active with logical path, or both are not - compare further
      if (aHasPath && !bHasPath) return -1;
      if (!aHasPath && bHasPath) return 1;

      if (aHasPath && bHasPath) {
        // Within same active status, sort by the full logical path (stem + metricType)
        const aPath = `${a.logicalPathStem}/${a.metricType}`;
        const bPath = `${b.logicalPathStem}/${b.metricType}`;
        return aPath.localeCompare(bPath);
      }

      // Neither has logical path, sort by displayName
      const aName = a.displayName || a.defaultName;
      const bName = b.displayName || b.defaultName;
      return aName.localeCompare(bName);
    });

    // Determine which aggregate column to use for each point (when using 5m or daily data)
    const getAggColumn = (
      metricType: string,
      transform: string | null,
      src: string,
    ) => {
      if (src === "daily") {
        // For daily data: delta for energy, avg for everything else
        if (metricType === "energy") return "delta";
        return "avg";
      }
      // For 5m data:
      // Energy points use delta (both cumulative counters and intervals)
      if (metricType === "energy") return "delta";
      // Power points use average
      if (metricType === "power") return "avg";
      // Everything else (SOC, etc.) uses last
      return "last";
    };

    // Build headers map from key to PointInfo
    const headers: Record<string, any> = {};

    // Add time or date header first
    if (source === "daily") {
      headers.date = null; // Special column for daily data (YYYY-MM-DD string)
    } else {
      headers.time = null; // Special column for raw/5m data (ISO8601 string)
    }

    // Add session label second
    headers.sessionLabel = null; // Special column, no point info

    sortedPoints.forEach((p) => {
      // Create PointInfo for the header
      const pointInfoObj = new PointInfo(
        p.index,
        systemId,
        p.physicalPathTail,
        p.logicalPathStem,
        p.metricType,
        p.metricUnit,
        p.defaultName,
        p.displayName,
        p.subsystem,
        p.transform,
        p.active,
        p.createdAtMs,
        p.updatedAtMs,
      );

      headers[`point_${p.index}`] = pointInfoObj;
    });

    // Build the per-point pivot columns (the MAX(CASE WHEN ...) projections) for the data source.
    // The surrounding query (cursor/order/limit) is built by fetchAdminPivotRowsPg from the params
    // below — only these column projections are passed through.
    let pivotColumns = "";

    if (source === "daily") {
      // Daily aggregated data
      pivotColumns = points
        .map((p) => {
          const aggCol = getAggColumn(p.metricType, p.transform, source);
          return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.index} THEN pr.${aggCol} END) as point_${p.index}`;
        })
        .join(",\n  ");
    } else if (source === "5m") {
      // 5-minute aggregated data
      pivotColumns = points
        .map((p) => {
          // For text fields, use value_str; for numeric fields, use the appropriate aggregate column
          if (p.metricUnit === "text") {
            return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.index} THEN pr.value_str END) as point_${p.index}`;
          }
          const aggCol = getAggColumn(p.metricType, p.transform, source);
          return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.index} THEN pr.${aggCol} END) as point_${p.index}`;
        })
        .join(",\n  ");
    } else {
      // Raw point readings
      pivotColumns = points
        .map((p) => {
          // For text fields, use value_str; for others, use value
          const column = p.metricUnit === "text" ? "pr.value_str" : "pr.value";
          return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.index} THEN ${column} END) as point_${p.index}`;
        })
        .join(",\n  ");
    }

    // Transform raw pivot rows → the served `data` shape.
    const buildPivotData = (rows: any[]) =>
      rows.map((row: any) => {
        // Use session_label from the joined sessions table, or fallback to session_id if label is null
        const sessionLabel =
          row.session_label || row.session_id?.toString() || null;

        const transformed: any = {
          sessionLabel: sessionLabel,
          sessionId: row.session_id || null,
        };

        // For daily data, use "date" field (YYYY-MM-DD); for others, use "time" field (ISO8601)
        if (source === "daily") {
          transformed.date = row.measurement_time; // YYYY-MM-DD string
        } else {
          // Convert Unix timestamp (ms) to ISO8601 with timezone
          transformed.time = formatTime_fromJSDate(
            new Date(row.measurement_time),
            system.timezoneOffsetMin,
          ); // ISO8601 string (e.g., "2025-11-09T14:30:00+10:00")
        }

        // Add point values in sorted order
        sortedPoints.forEach((p) => {
          const value = row[`point_${p.index}`];
          // For text fields, keep as string; for others, convert to number and apply transform
          if (value !== null) {
            if (p.metricUnit === "text") {
              transformed[`point_${p.index}`] = String(value);
            } else {
              const numValue = Number(value);
              transformed[`point_${p.index}`] = applyTransform(
                numValue,
                p.transform,
              );
            }
          } else {
            transformed[`point_${p.index}`] = null;
          }
        });

        return transformed;
      });

    // Serve the pivot from Postgres.
    const t0 = Date.now();
    const result = await fetchAdminPivotRowsPg({
      systemId,
      source,
      cursor,
      direction,
      limit,
      pivotColumns,
    });
    const data = buildPivotData(result);
    dbElapsedMs += Date.now() - t0;

    // If no data, check if the other tables have data
    let hasAlternativeData = false;
    if (result.length === 0) {
      const alternativeTableName =
        source === "raw"
          ? "point_readings_agg_5m"
          : source === "daily"
            ? "point_readings"
            : "point_readings";
      const checkStartTime = Date.now();
      // Existence check: SELECT 1 … LIMIT 1 stops at the first matching row (index-friendly).
      // NOT COUNT(*), which scans every matching row — prohibitively slow on the big tables.
      const checkResult = await pgRows(
        `SELECT 1 FROM ${alternativeTableName} WHERE system_id = ${systemId} LIMIT 1`,
      );
      dbElapsedMs += Date.now() - checkStartTime;
      hasAlternativeData = checkResult.length > 0;
    }

    // (`data` is computed above by the shared `buildPivotData`, under the readings shadow.)

    // Get raw timestamps from result for database queries
    const firstTimestamp =
      result.length > 0 ? (result[0] as any).measurement_time : null;
    const lastTimestamp =
      result.length > 0
        ? (result[result.length - 1] as any).measurement_time
        : null;

    // Format cursors for API response (ISO8601 for raw/5m, YYYY-MM-DD for daily)
    const firstCursor =
      result.length > 0
        ? source === "daily"
          ? firstTimestamp // YYYY-MM-DD string
          : formatTime_fromJSDate(
              new Date(firstTimestamp),
              system.timezoneOffsetMin,
            ) // ISO8601 string
        : null;
    const lastCursor =
      result.length > 0
        ? source === "daily"
          ? lastTimestamp // YYYY-MM-DD string
          : formatTime_fromJSDate(
              new Date(lastTimestamp),
              system.timezoneOffsetMin,
            ) // ISO8601 string
        : null;

    // Check if there are more records in each direction
    let hasOlder = false;
    let hasNewer = false;

    if (result.length > 0) {
      const tableName =
        source === "daily"
          ? "point_readings_agg_1d"
          : source === "5m"
            ? "point_readings_agg_5m"
            : "point_readings";
      const timeColumn =
        source === "daily"
          ? "day"
          : source === "5m"
            ? "interval_end"
            : "measurement_time";

      const checkStartTime = Date.now();

      // For daily data, use YYYY-MM-DD string comparison; for raw/5m the cursors are epoch-ms,
      // converted to a PG timestamp literal via to_timestamp().
      const olderCondition =
        source === "daily"
          ? `${timeColumn} < '${lastTimestamp}'`
          : `${timeColumn} < to_timestamp(${Number(lastTimestamp)} / 1000.0)`;
      const newerCondition =
        source === "daily"
          ? `${timeColumn} > '${firstTimestamp}'`
          : `${timeColumn} > to_timestamp(${Number(firstTimestamp)} / 1000.0)`;

      // Existence checks: SELECT 1 … LIMIT 1 short-circuits at the first matching row via the
      // (system_id, <time>) index.
      const olderCheck = await pgRows(
        `SELECT 1 FROM ${tableName} WHERE system_id = ${systemId} AND ${olderCondition} LIMIT 1`,
      );
      hasOlder = olderCheck.length > 0;

      const newerCheck = await pgRows(
        `SELECT 1 FROM ${tableName} WHERE system_id = ${systemId} AND ${newerCondition} LIMIT 1`,
      );
      hasNewer = newerCheck.length > 0;

      dbElapsedMs += Date.now() - checkStartTime;
    }

    return NextResponse.json({
      headers,
      data,
      metadata: {
        systemId,
        systemShortName: system.alias || null,
        ownerUsername: username,
        timezoneOffsetMin: system.timezoneOffsetMin,
        pointCount: points.length,
        rowCount: data.length,
        dbElapsedMs,
        hasAlternativeData,
      },
      pagination: {
        firstCursor,
        lastCursor,
        hasOlder,
        hasNewer,
        limit,
      },
    });
  } catch (error) {
    console.error("Error fetching point readings:", error);
    return NextResponse.json(
      { error: "Failed to fetch point readings" },
      { status: 500 },
    );
  }
}
