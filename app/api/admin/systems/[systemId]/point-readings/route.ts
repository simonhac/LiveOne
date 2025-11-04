import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { pointReadings, pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, desc, sql } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { formatTimeAEST } from "@/lib/date-utils";
import { fromDate } from "@internationalized/date";
import { SystemsManager } from "@/lib/systems-manager";

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

    // Build headers with metadata for each column
    const headers = [
      {
        key: "timestamp",
        label: "Time",
        type: "datetime",
        unit: null,
        subsystem: null,
        pointId: "",
        pointSubId: null,
        pointDbId: 0,
        systemId: 0,
        defaultName: "",
        shortName: null,
        active: true,
      },
      {
        key: "sessionId",
        label: "Session",
        type: "number",
        unit: null,
        subsystem: null,
        pointId: "",
        pointSubId: null,
        pointDbId: 0,
        systemId: 0,
        defaultName: "",
        shortName: null,
        active: true,
      },
      ...sortedPoints.map((p) => ({
        key: `point_${p.id}`,
        label: p.displayName || p.defaultName,
        type: p.metricType,
        unit: p.metricUnit,
        subsystem: p.subsystem,
        pointType: p.type,
        subtype: p.subtype,
        extension: p.extension,
        pointId: p.pointId,
        pointSubId: p.pointSubId,
        pointDbId: p.id,
        systemId: systemId,
        defaultName: p.defaultName,
        shortName: p.shortName,
        active: p.active,
      })),
    ];

    // Build dynamic SQL for pivot query (still uses all points, order doesn't matter here)
    const pivotColumns = points
      .map(
        (p) =>
          `MAX(CASE WHEN system_id = ${systemId} AND point_id = ${p.id} THEN value END) as point_${p.id}`,
      )
      .join(",\n  ");

    // Get sessionIds for each point at each timestamp
    const sessionIdColumns = points
      .map(
        (p) =>
          `MAX(CASE WHEN system_id = ${systemId} AND point_id = ${p.id} THEN session_id END) as session_${p.id}`,
      )
      .join(",\n  ");

    // Query to get pivoted data - last N readings by unique timestamp
    // Group by both timestamp AND session_id to split rows with different sessionIds
    const pivotQuery = `
      WITH recent_timestamps AS (
        SELECT DISTINCT measurement_time
        FROM point_readings pr
        INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
        WHERE pi.system_id = ${systemId}
        ORDER BY measurement_time DESC
        LIMIT ${limit}
      )
      SELECT
        measurement_time,
        ${pivotColumns},
        ${sessionIdColumns}
      FROM point_readings
      WHERE system_id = ${systemId}
        AND measurement_time IN (SELECT measurement_time FROM recent_timestamps)
      GROUP BY measurement_time, session_id
      ORDER BY measurement_time DESC, session_id
    `;

    const pivotStartTime = Date.now();
    const result = await db.all(sql.raw(pivotQuery));
    dbElapsedMs += Date.now() - pivotStartTime;

    // Transform the data to include ISO timestamps with AEST formatting
    const data = result.map((row: any) => {
      // Convert Unix timestamp (ms) to ZonedDateTime and format with AEST
      const zonedDate = fromDate(
        new Date(row.measurement_time),
        "Australia/Brisbane",
      );
      const formattedTime = formatTimeAEST(zonedDate);

      // Extract sessionId from the first non-null session_* column
      let sessionId: number | null = null;
      for (const p of sortedPoints) {
        const sid = row[`session_${p.id}`];
        if (sid !== null && sid !== undefined) {
          sessionId = Number(sid);
          break;
        }
      }

      const transformed: any = {
        timestamp: formattedTime,
        sessionId: sessionId,
      };

      // Add point values in sorted order
      sortedPoints.forEach((p) => {
        const value = row[`point_${p.id}`];
        transformed[`point_${p.id}`] = value !== null ? Number(value) : null;
      });

      return transformed;
    });

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
