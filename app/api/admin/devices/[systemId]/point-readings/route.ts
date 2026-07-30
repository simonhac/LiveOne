import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { PointInfo } from "@/lib/point/point-info";
import { resolvePointDisplay } from "@/lib/point/display/registry";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import {
  ReadingsDao,
  type AdminPivotValueColumn,
  type ReadingStore,
} from "@/lib/readings/dao";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as pgDevices,
  points as pgPointsTable,
} from "@/lib/db/planetscale/schema";
import { DeviceRegistry } from "@/lib/registry";
import { Point } from "@/lib/ids";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

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
    if (!/^[1-9]\d*$/.test(systemIdStr))
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    const systemId = Number(systemIdStr);
    if (!Number.isSafeInteger(systemId))
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit") || "200";
    if (!/^[1-9]\d*$/.test(limitParam))
      return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
    const limit = Math.min(Number(limitParam), 1000);
    const sourceParam = searchParams.get("source") || "raw";
    if (!["raw", "5m", "daily"].includes(sourceParam))
      return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    const source = sourceParam as "raw" | "5m" | "daily";
    const cursorParam = searchParams.get("cursor"); // ISO8601 string for raw/5m, YYYY-MM-DD for daily
    const directionParam = searchParams.get("direction") || "newer";
    if (!["older", "newer"].includes(directionParam))
      return NextResponse.json({ error: "Invalid direction" }, { status: 400 });
    const direction = directionParam as "older" | "newer";

    // Track database elapsed time
    let dbElapsedMs = 0;

    // Get the device from the config registry (per-request memoized)
    const device = await DeviceConfigRegistry.deviceByHandle(systemId);

    if (!device) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Convert cursor to database format (millisecond timestamp for raw/5m, YYYY-MM-DD for daily)
    let cursor: number | string | null = null;
    if (cursorParam) {
      if (source === "daily") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(cursorParam))
          return NextResponse.json(
            { error: "Invalid daily cursor" },
            { status: 400 },
          );
        cursor = cursorParam;
      } else {
        // Parse ISO8601 to Unix timestamp milliseconds
        cursor = new Date(cursorParam).getTime();
        if (!Number.isFinite(cursor))
          return NextResponse.json(
            { error: "Invalid timestamp cursor" },
            { status: 400 },
          );
      }
    }

    // Get username from system owner
    let username: string | null = null;
    if (device.ownerClerkUserId) {
      try {
        const clerk = await clerkClient();
        const owner = await clerk.users.getUser(device.ownerClerkUserId);
        username = owner.username || null;
      } catch (error) {
        console.error("Error fetching owner username:", error);
      }
    }

    // Get all point info for this device
    const pointsStartTime = Date.now();
    // `points ⋈ devices` (slice 1b), projected explicitly: the served shape this route feeds into
    // `new PointInfo(...)` is no longer one table's columns — `systemId` is the owning device's handle
    // and `index` is the global `points.rid`.
    const pgPoints = await requirePlanetscaleDb()
      .select({
        systemId: pgDevices.rid,
        index: pgPointsTable.rid,
        pointUid: pgPointsTable.id,
        physicalPathTail: pgPointsTable.physicalPath,
        logicalPathStem: pgPointsTable.logicalPath,
        metricType: pgPointsTable.metricType,
        metricUnit: pgPointsTable.unit,
        defaultName: pgPointsTable.defaultName,
        displayName: pgPointsTable.name,
        subsystem: pgPointsTable.subsystem,
        transform: pgPointsTable.transform,
        active: pgPointsTable.active,
        createdAt: pgPointsTable.createdAt,
        updatedAt: pgPointsTable.updatedAt,
      })
      .from(pgPointsTable)
      .innerJoin(pgDevices, eq(pgDevices.id, pgPointsTable.deviceId))
      .where(eq(pgDevices.rid, systemId))
      .orderBy(pgPointsTable.rid);
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
          deviceShortName: device.alias || null,
          ownerUsername: username,
          timezoneOffsetMin: device.timezoneOffsetMin,
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
      src: "5m" | "daily",
    ): AdminPivotValueColumn => {
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
      // Resolve display metadata (unit + Excel number format) from the central registry.
      const display = resolvePointDisplay(
        device.vendorType,
        p.subsystem,
        p.physicalPathTail,
      );
      // Create PointInfo for the header. `pointUid` rides along to the client so
      // `ViewDataModal` can rebuild a full-identity PointInfo (config-v4 slice D) — the same
      // uuid the pivot query below already keys on.
      const pointInfoObj = new PointInfo(
        p.pointUid,
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
        display?.unit ?? null,
        display?.format ?? null,
      );

      headers[`point_${p.index}`] = pointInfoObj;
    });

    const deviceAddr = await DeviceRegistry.addrForHandle(systemId);
    const pivotPoints = points.map((p) => {
      const valueColumn: AdminPivotValueColumn =
        source === "raw"
          ? p.metricUnit === "text"
            ? "valueStr"
            : "value"
          : source === "5m" && p.metricUnit === "text"
            ? "valueStr"
            : getAggColumn(p.metricType, source);
      return {
        point: Point.encode(p.pointUid),
        outputKey: `point_${p.index}`,
        valueColumn,
      };
    });

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
            device.timezoneOffsetMin,
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

    // Serve the pivot from Postgres via the readings seam.
    const t0 = Date.now();
    const result = await ReadingsDao.readAdminPivot({
      device: deviceAddr.deviceId,
      source,
      cursor,
      direction,
      limit,
      points: pivotPoints,
    });
    const data = buildPivotData(result);
    dbElapsedMs += Date.now() - t0;

    // If no data, check whether the OTHER store has data (raw → 5m; 5m/daily → raw). Existence-only:
    // the seam issues SELECT 1 … LIMIT 1 (index-friendly), never COUNT(*) on the big tables.
    let hasAlternativeData = false;
    if (result.length === 0) {
      const altStore: ReadingStore = source === "raw" ? "agg5m" : "raw";
      const checkStartTime = Date.now();
      hasAlternativeData = await ReadingsDao.hasReadingsForDevice(
        deviceAddr.deviceId,
        altStore,
      );
      dbElapsedMs += Date.now() - checkStartTime;
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
              device.timezoneOffsetMin,
            ) // ISO8601 string
        : null;
    const lastCursor =
      result.length > 0
        ? source === "daily"
          ? lastTimestamp // YYYY-MM-DD string
          : formatTime_fromJSDate(
              new Date(lastTimestamp),
              device.timezoneOffsetMin,
            ) // ISO8601 string
        : null;

    // Check if there are more records in each direction (existence-only via the seam: SELECT 1 …
    // LIMIT 1 short-circuits at the first matching row via the (system_id, <time>) index).
    let hasOlder = false;
    let hasNewer = false;

    if (result.length > 0) {
      const store: ReadingStore =
        source === "daily" ? "agg1d" : source === "5m" ? "agg5m" : "raw";
      const checkStartTime = Date.now();
      // `lastTimestamp`/`firstTimestamp` are epoch-ms (raw/5m) or YYYY-MM-DD strings (daily); the seam
      // reproduces the legacy `< to_timestamp(ms/1000.0)` / `< 'YYYY-MM-DD'` comparison per store.
      hasOlder = await ReadingsDao.hasReadingsForDeviceBeyond(
        deviceAddr.deviceId,
        store,
        lastTimestamp,
        "older",
      );
      hasNewer = await ReadingsDao.hasReadingsForDeviceBeyond(
        deviceAddr.deviceId,
        store,
        firstTimestamp,
        "newer",
      );
      dbElapsedMs += Date.now() - checkStartTime;
    }

    return NextResponse.json({
      headers,
      data,
      metadata: {
        systemId,
        deviceShortName: device.alias || null,
        ownerUsername: username,
        timezoneOffsetMin: device.timezoneOffsetMin,
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
