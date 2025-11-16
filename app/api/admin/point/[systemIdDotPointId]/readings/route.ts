import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { decodeUrlDateToEpoch, decodeUrlOffset } from "@/lib/url-date";
import { formatDateYYYYMMDD, parseDateYYYYMMDD } from "@/lib/date-utils";

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

    // Parse systemId.pointId from path param (e.g., "1586.1")
    const parts = systemIdDotPointId.split(".");
    if (parts.length !== 2) {
      return NextResponse.json(
        { error: "Invalid format. Expected systemId.pointId (e.g., 1586.1)" },
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

    // Support both raw epoch milliseconds and encoded timestamps
    const timestampParam = searchParams.get("timestamp");
    const timeParam = searchParams.get("time"); // URL-encoded time
    const offsetParam = searchParams.get("offset"); // Timezone offset
    const dateParam = searchParams.get("date"); // YYYYMMDD format for daily data
    const source = searchParams.get("source") || "raw";

    let timestamp: number | null = null;
    let targetDate: string | null = null;

    if (source === "daily") {
      // For daily data, expect date parameter in YYYYMMDD format
      if (!dateParam) {
        return NextResponse.json(
          { error: "date parameter required for daily data source" },
          { status: 400 },
        );
      }
      targetDate = dateParam;
    } else {
      // For raw and 5m data, expect timestamp
      if (timeParam && offsetParam) {
        // Decode URL-encoded time with timezone
        try {
          const offsetMin = decodeUrlOffset(offsetParam);
          timestamp = decodeUrlDateToEpoch(timeParam, offsetMin);
        } catch (error) {
          return NextResponse.json(
            { error: "Invalid time or offset parameter" },
            { status: 400 },
          );
        }
      } else if (timestampParam) {
        // Legacy: raw epoch milliseconds
        timestamp = parseInt(timestampParam);
        if (isNaN(timestamp) || !timestamp) {
          return NextResponse.json(
            { error: "Invalid timestamp parameter" },
            { status: 400 },
          );
        }
      } else {
        return NextResponse.json(
          { error: "Either timestamp or time+offset parameters required" },
          { status: 400 },
        );
      }
    }

    if (source !== "raw" && source !== "5m" && source !== "daily") {
      return NextResponse.json(
        { error: "source must be 'raw', '5m', or 'daily'" },
        { status: 400 },
      );
    }

    let readings: any[] = [];

    if (source === "daily") {
      // targetDate is guaranteed to be non-null by validation above
      const date = parseDateYYYYMMDD(targetDate!);

      // Fetch wider range: 9 days before and 9 days after
      const startDay = date.subtract({ days: 9 });
      const endDay = date.add({ days: 9 });

      // Format as YYYYMMDD strings
      const startDayStr = formatDateYYYYMMDD(startDay);
      const endDayStr = formatDateYYYYMMDD(endDay);

      // Query daily aggregated data
      const query = `
        SELECT
          pr.system_id as systemId,
          pr.point_id as pointId,
          pr.day as date,
          pr.avg,
          pr.min,
          pr.max,
          pr.last,
          pr.delta,
          pr.sample_count as sampleCount,
          pr.error_count as errorCount
        FROM point_readings_agg_1d pr
        WHERE pr.system_id = ${systemId}
          AND pr.point_id = ${pointId}
          AND pr.day >= '${startDayStr}'
          AND pr.day <= '${endDayStr}'
        ORDER BY pr.day ASC
      `;

      const allReadings = await db.all(sql.raw(query));

      // Find target index
      const targetIndex = allReadings.findIndex(
        (r: any) => r.date === targetDate,
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
    } else if (source === "5m") {
      // timestamp is guaranteed to be non-null for 5m data
      // Use window functions to get records centered around target
      // Get 10 before + target + 10 after = 21 records max, then trim to 11
      const query = `
        WITH all_rows AS (
          SELECT
            interval_end,
            ROW_NUMBER() OVER (ORDER BY interval_end ASC) as row_num
          FROM point_readings_agg_5m
          WHERE system_id = ${systemId}
            AND point_id = ${pointId}
        ),
        target_position AS (
          SELECT row_num as target_row
          FROM all_rows
          WHERE interval_end = ${timestamp}
        ),
        ranked AS (
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
            pr.data_quality as dataQuality,
            s.session_label as sessionLabel,
            ROW_NUMBER() OVER (ORDER BY pr.interval_end ASC) as row_num
          FROM point_readings_agg_5m pr
          LEFT JOIN sessions s ON pr.session_id = s.id
          WHERE pr.system_id = ${systemId}
            AND pr.point_id = ${pointId}
        )
        SELECT ranked.* FROM ranked, target_position
        WHERE ranked.row_num BETWEEN (target_position.target_row - 10) AND (target_position.target_row + 10)
        ORDER BY intervalEnd ASC
      `;

      const allReadings = await db.all(sql.raw(query));

      // Find target index in results
      const targetIndex = allReadings.findIndex(
        (r: any) => r.intervalEnd === timestamp,
      );

      if (targetIndex === -1) {
        // Target not found, return empty
        readings = [];
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
      // timestamp is guaranteed to be non-null for raw data
      const oneHour = 60 * 60 * 1000;
      const startTime = timestamp! - oneHour;
      const endTime = timestamp! + oneHour;

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
        ...(source === "daily" ? { targetDate } : { timestamp }),
        source,
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
