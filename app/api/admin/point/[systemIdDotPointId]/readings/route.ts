import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ systemIdDotPointId: string }> },
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

    const { systemIdDotPointId } = await params;
    const { searchParams } = new URL(request.url);

    // Parse systemId.pointId from path param
    const parts = systemIdDotPointId.split(".");
    if (parts.length !== 2) {
      return NextResponse.json(
        { error: "Invalid systemId.pointId format" },
        { status: 400 },
      );
    }

    const systemId = parseInt(parts[0]);
    const pointId = parseInt(parts[1]);

    if (isNaN(systemId) || isNaN(pointId)) {
      return NextResponse.json(
        { error: "Invalid systemId or pointId" },
        { status: 400 },
      );
    }

    const timestamp = parseInt(searchParams.get("timestamp") || "0");
    const dataSource = searchParams.get("dataSource") || "raw";

    if (!timestamp) {
      return NextResponse.json(
        { error: "timestamp parameter required" },
        { status: 400 },
      );
    }

    if (dataSource !== "raw" && dataSource !== "5m") {
      return NextResponse.json(
        { error: "dataSource must be 'raw' or '5m'" },
        { status: 400 },
      );
    }

    // Calculate ±1 hour window
    const oneHour = 60 * 60 * 1000;
    const startTime = timestamp - oneHour;
    const endTime = timestamp + oneHour;

    let readings: any[] = [];

    if (dataSource === "5m") {
      // Query 5-minute aggregated data with session labels
      const query = `
        SELECT
          pr.system_id as systemId,
          pr.point_id as pointId,
          pr.session_id as sessionId,
          pr.interval_end as intervalEnd,
          pr.avg,
          pr.min,
          pr.max,
          pr.last,
          pr.delta,
          pr.sample_count as sampleCount,
          pr.error_count as errorCount,
          s.session_label as sessionLabel
        FROM point_readings_agg_5m pr
        LEFT JOIN sessions s ON pr.session_id = s.id
        WHERE pr.system_id = ${systemId}
          AND pr.point_id = ${pointId}
          AND pr.interval_end >= ${startTime}
          AND pr.interval_end <= ${endTime}
        ORDER BY pr.interval_end ASC
      `;

      const allReadings = await db.all(sql.raw(query));

      // Find target index
      const targetIndex = allReadings.findIndex(
        (r: any) => r.intervalEnd === timestamp,
      );

      if (targetIndex === -1) {
        // Target not found, return all readings
        readings = allReadings;
      } else {
        // Calculate ideal range: 5 before, target, 5 after
        let startIndex = Math.max(0, targetIndex - 5);
        let endIndex = Math.min(allReadings.length, targetIndex + 6);

        // If we don't have enough before, show more after (up to 10 after)
        if (targetIndex < 5) {
          endIndex = Math.min(allReadings.length, targetIndex + 11);
        }

        // If we don't have enough after, show more before (up to 10 before)
        if (targetIndex + 6 > allReadings.length) {
          startIndex = Math.max(0, targetIndex - 10);
        }

        readings = allReadings.slice(startIndex, endIndex);
      }
    } else {
      // Query raw point readings with session labels
      const query = `
        SELECT
          pr.id,
          pr.system_id as systemId,
          pr.point_id as pointId,
          pr.session_id as sessionId,
          pr.measurement_time as measurementTime,
          pr.received_time as receivedTime,
          pr.value,
          pr.value_str as valueStr,
          pr.error,
          pr.data_quality as dataQuality,
          s.session_label as sessionLabel
        FROM point_readings pr
        LEFT JOIN sessions s ON pr.session_id = s.id
        WHERE pr.system_id = ${systemId}
          AND pr.point_id = ${pointId}
          AND pr.measurement_time >= ${startTime}
          AND pr.measurement_time <= ${endTime}
        ORDER BY pr.measurement_time ASC
      `;

      const allReadings = await db.all(sql.raw(query));

      // Find target index
      const targetIndex = allReadings.findIndex(
        (r: any) => r.measurementTime === timestamp,
      );

      if (targetIndex === -1) {
        // Target not found, return all readings
        readings = allReadings;
      } else {
        // Calculate ideal range: 5 before, target, 5 after
        let startIndex = Math.max(0, targetIndex - 5);
        let endIndex = Math.min(allReadings.length, targetIndex + 6);

        // If we don't have enough before, show more after (up to 10 after)
        if (targetIndex < 5) {
          endIndex = Math.min(allReadings.length, targetIndex + 11);
        }

        // If we don't have enough after, show more before (up to 10 before)
        if (targetIndex + 6 > allReadings.length) {
          startIndex = Math.max(0, targetIndex - 10);
        }

        readings = allReadings.slice(startIndex, endIndex);
      }
    }

    return NextResponse.json({
      readings,
      metadata: {
        systemId,
        pointId,
        timestamp,
        dataSource,
        windowStart: startTime,
        windowEnd: endTime,
        totalInWindow: readings.length,
      },
    });
  } catch (error) {
    console.error("Error fetching point reading details:", error);
    return NextResponse.json(
      { error: "Failed to fetch reading details" },
      { status: 500 },
    );
  }
}
