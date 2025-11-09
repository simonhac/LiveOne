import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, sql } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { PointInfo } from "@/lib/point-info";

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
  request: Request,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const { userId } = await auth();

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

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "200"), 1000);
    const source = searchParams.get("source") || "raw"; // "raw", "5m", or "daily"
    const cursor = searchParams.get("cursor"); // timestamp cursor for pagination (or day for daily)
    const direction = searchParams.get("direction") || "newer"; // "older" or "newer"

    // Track database elapsed time
    let dbElapsedMs = 0;

    // Get system from SystemsManager (already cached in memory)
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
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
    const points = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, systemId))
      .orderBy(pointInfo.id);
    dbElapsedMs += Date.now() - pointsStartTime;

    if (points.length === 0) {
      return NextResponse.json({
        headers: [],
        data: [],
        metadata: {
          systemId,
          systemShortName: system.shortName || null,
          ownerUsername: username,
          timezoneOffsetMin: system.timezoneOffsetMin,
          pointCount: 0,
          rowCount: 0,
          dbElapsedMs,
        },
      });
    }

    // Sort points: series ID columns first (sorted by series ID), then by displayName
    const sortedPoints = [...points].sort((a, b) => {
      const aHasSeriesId = !!a.type;
      const bHasSeriesId = !!b.type;

      // Points with series ID come first
      if (aHasSeriesId && !bHasSeriesId) return -1;
      if (!aHasSeriesId && bHasSeriesId) return 1;

      if (aHasSeriesId && bHasSeriesId) {
        // Both have series ID, sort by the series ID string
        const aSeriesId = [a.type, a.subtype, a.extension, a.metricType]
          .filter(Boolean)
          .join(".");
        const bSeriesId = [b.type, b.subtype, b.extension, b.metricType]
          .filter(Boolean)
          .join(".");
        return aSeriesId.localeCompare(bSeriesId);
      }

      // Neither has series ID, sort by displayName
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
        // For daily data: delta for energy (transform='d'), avg for everything else
        if (transform === "d") return "delta";
        return "avg";
      }
      // For 5m data:
      // Points with transform='d' use delta column
      if (transform === "d") return "delta";
      // Power points use average
      if (metricType === "power") return "avg";
      // Everything else uses last
      return "last";
    };

    // Build headers map from key to PointInfo
    const headers: Record<string, any> = {};

    // Add timestamp or date header first
    if (source === "daily") {
      headers.date = null; // Special column for daily data (YYYYMMDD string)
    } else {
      headers.timestamp = null; // Special column for raw/5m data (Unix timestamp)
    }

    // Add session label second
    headers.sessionLabel = null; // Special column, no point info

    sortedPoints.forEach((p) => {
      // For agg data, append the summary type to the extension field
      const aggColumn =
        source === "5m" || source === "daily"
          ? getAggColumn(p.metricType, p.transform, source)
          : null;
      const extension =
        (source === "5m" || source === "daily") && aggColumn
          ? p.extension
            ? `${p.extension}.${aggColumn}`
            : aggColumn
          : p.extension;

      // Create PointInfo with modified extension for 5m aggregates
      const pointInfo = new PointInfo(
        p.id,
        systemId,
        p.originId,
        p.originSubId,
        p.shortName,
        p.defaultName,
        p.displayName,
        p.subsystem,
        p.type,
        p.subtype,
        extension,
        p.metricType,
        p.metricUnit,
        p.transform,
        p.active,
      );

      headers[`point_${p.id}`] = pointInfo;
    });

    // Build dynamic SQL for pivot query based on data source
    let pivotQuery: string;

    if (source === "daily") {
      // Query daily aggregated data
      const pivotColumns = points
        .map((p) => {
          const aggCol = getAggColumn(p.metricType, p.transform, source);
          return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.id} THEN pr.${aggCol} END) as point_${p.id}`;
        })
        .join(",\n  ");

      // Build cursor filter (day is in YYYYMMDD format)
      const cursorFilter = cursor
        ? direction === "older"
          ? `AND day < '${cursor}'`
          : `AND day > '${cursor}'`
        : "";

      // For "newer" direction, we need to reverse the order to get the correct records
      const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";

      pivotQuery = `
        WITH recent_days AS (
          SELECT DISTINCT day
          FROM point_readings_agg_1d pr
          INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
          WHERE pi.system_id = ${systemId}
          ${cursorFilter}
          ORDER BY day ${orderDirection}
          LIMIT ${limit}
        )
        SELECT
          pr.day as measurement_time,
          NULL as session_id,
          NULL as session_label,
          ${pivotColumns}
        FROM point_readings_agg_1d pr
        WHERE pr.system_id = ${systemId}
          AND pr.day IN (SELECT day FROM recent_days)
        GROUP BY pr.day
        ORDER BY pr.day DESC
      `;
    } else if (source === "5m") {
      // Query 5-minute aggregated data
      const pivotColumns = points
        .map((p) => {
          const aggCol = getAggColumn(p.metricType, p.transform, source);
          return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.id} THEN pr.${aggCol} END) as point_${p.id}`;
        })
        .join(",\n  ");

      // Build cursor filter
      const cursorFilter = cursor
        ? direction === "older"
          ? `AND interval_end < ${cursor}`
          : `AND interval_end > ${cursor}`
        : "";

      // For "newer" direction, we need to reverse the order to get the correct records
      const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";

      pivotQuery = `
        WITH recent_timestamps AS (
          SELECT DISTINCT interval_end
          FROM point_readings_agg_5m pr
          INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
          WHERE pi.system_id = ${systemId}
          ${cursorFilter}
          ORDER BY interval_end ${orderDirection}
          LIMIT ${limit}
        )
        SELECT
          pr.interval_end as measurement_time,
          pr.session_id,
          s.session_label,
          ${pivotColumns}
        FROM point_readings_agg_5m pr
        LEFT JOIN sessions s ON pr.session_id = s.id
        WHERE pr.system_id = ${systemId}
          AND pr.interval_end IN (SELECT interval_end FROM recent_timestamps)
        GROUP BY pr.interval_end, pr.session_id
        ORDER BY pr.interval_end DESC, pr.session_id
      `;
    } else {
      // Query raw point readings
      const pivotColumns = points
        .map((p) => {
          // For text fields, use valueStr; for others, use value
          const column = p.metricUnit === "text" ? "pr.value_str" : "pr.value";
          return `MAX(CASE WHEN pr.system_id = ${systemId} AND pr.point_id = ${p.id} THEN ${column} END) as point_${p.id}`;
        })
        .join(",\n  ");

      // Build cursor filter
      const cursorFilter = cursor
        ? direction === "older"
          ? `AND measurement_time < ${cursor}`
          : `AND measurement_time > ${cursor}`
        : "";

      // For "newer" direction, we need to reverse the order to get the correct records
      const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";

      pivotQuery = `
        WITH recent_timestamps AS (
          SELECT DISTINCT measurement_time
          FROM point_readings pr
          INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
          WHERE pi.system_id = ${systemId}
          ${cursorFilter}
          ORDER BY measurement_time ${orderDirection}
          LIMIT ${limit}
        )
        SELECT
          pr.measurement_time,
          pr.session_id,
          s.session_label,
          ${pivotColumns}
        FROM point_readings pr
        LEFT JOIN sessions s ON pr.session_id = s.id
        WHERE pr.system_id = ${systemId}
          AND pr.measurement_time IN (SELECT measurement_time FROM recent_timestamps)
        GROUP BY pr.measurement_time, pr.session_id
        ORDER BY pr.measurement_time DESC, pr.session_id
      `;
    }

    const pivotStartTime = Date.now();
    let result: any[] = [];
    try {
      result = await db.all(sql.raw(pivotQuery));
    } catch (error: any) {
      // Handle case where table doesn't exist yet (e.g., migration not run)
      if (error?.message?.includes("no such table")) {
        console.warn(
          `Table for ${source} data source not found. Returning empty result.`,
        );
        result = [];
      } else {
        throw error;
      }
    }
    dbElapsedMs += Date.now() - pivotStartTime;

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
      const checkResult = (await db.all(
        sql.raw(
          `SELECT COUNT(*) as count FROM ${alternativeTableName} WHERE system_id = ${systemId} LIMIT 1`,
        ),
      )) as Array<{ count: number }>;
      dbElapsedMs += Date.now() - checkStartTime;
      hasAlternativeData = (checkResult[0]?.count || 0) > 0;
    }

    // Transform the data
    const data = result.map((row: any) => {
      // Use session_label from the joined sessions table, or fallback to session_id if label is null
      const sessionLabel =
        row.session_label || row.session_id?.toString() || null;

      const transformed: any = {
        sessionLabel: sessionLabel,
        sessionId: row.session_id || null,
      };

      // For daily data, use "date" field; for others, use "timestamp"
      if (source === "daily") {
        transformed.date = row.measurement_time; // YYYYMMDD string
      } else {
        transformed.timestamp = row.measurement_time; // Unix timestamp (epochMs)
      }

      // Add point values in sorted order
      sortedPoints.forEach((p) => {
        const value = row[`point_${p.id}`];
        // For text fields, keep as string; for others, convert to number and apply transform
        if (value !== null) {
          if (p.metricUnit === "text") {
            transformed[`point_${p.id}`] = String(value);
          } else {
            const numValue = Number(value);
            transformed[`point_${p.id}`] = applyTransform(
              numValue,
              p.transform,
            );
          }
        } else {
          transformed[`point_${p.id}`] = null;
        }
      });

      return transformed;
    });

    // Get pagination cursors
    const firstCursor =
      result.length > 0 ? (result[0] as any).measurement_time : null;
    const lastCursor =
      result.length > 0
        ? (result[result.length - 1] as any).measurement_time
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

      // For daily data, cursor is a YYYYMMDD string; for others it's a timestamp
      const olderCondition =
        source === "daily"
          ? `${timeColumn} < '${lastCursor}'`
          : `${timeColumn} < ${lastCursor}`;
      const newerCondition =
        source === "daily"
          ? `${timeColumn} > '${firstCursor}'`
          : `${timeColumn} > ${firstCursor}`;

      // Check for older records
      const olderCheck = (await db.all(
        sql.raw(
          `SELECT COUNT(*) as count FROM ${tableName} WHERE system_id = ${systemId} AND ${olderCondition} LIMIT 1`,
        ),
      )) as Array<{ count: number }>;
      hasOlder = (olderCheck[0]?.count || 0) > 0;

      // Check for newer records
      const newerCheck = (await db.all(
        sql.raw(
          `SELECT COUNT(*) as count FROM ${tableName} WHERE system_id = ${systemId} AND ${newerCondition} LIMIT 1`,
        ),
      )) as Array<{ count: number }>;
      hasNewer = (newerCheck[0]?.count || 0) > 0;

      dbElapsedMs += Date.now() - checkStartTime;
    }

    return NextResponse.json({
      headers,
      data,
      metadata: {
        systemId,
        systemShortName: system.shortName || null,
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
