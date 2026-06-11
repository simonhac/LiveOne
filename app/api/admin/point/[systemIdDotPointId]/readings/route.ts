import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { decodeUrlDateToEpoch, decodeUrlOffset } from "@/lib/url-date";
import { formatDateYYYYMMDD, parseDateYYYYMMDD } from "@/lib/date-utils";
import { fetchSinglePointReadingsPg } from "@/lib/db/planetscale/readings-read-pg";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemIdDotPointId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

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

    // Serve the window from Postgres under READINGS_READS_FROM_PG, falling back to Turso on
    // error/SHADOW_SKIP (PR-13a). With the flag off, Turso is served exactly as before.
    let dailyStartDayStr: string | undefined;
    let dailyEndDayStr: string | undefined;
    if (source === "daily") {
      // targetDate is guaranteed to be non-null by validation above.
      // Fetch wider range: 9 days before and 9 days after.
      const date = parseDateYYYYMMDD(targetDate!);
      dailyStartDayStr = formatDateYYYYMMDD(date.subtract({ days: 9 }));
      dailyEndDayStr = formatDateYYYYMMDD(date.add({ days: 9 }));
    }

    // Center the window on the target row (±5, widening to ±10 at the edges). Pure; shared by the
    // PG served path and the Turso fallback path.
    const centerReadings = (allReadings: any[]): any[] => {
      let targetIndex: number;
      if (source === "daily") {
        targetIndex = allReadings.findIndex((r: any) => r.date === targetDate);
      } else if (source === "5m") {
        targetIndex = allReadings.findIndex(
          (r: any) => r.intervalEnd === timestamp,
        );
      } else {
        targetIndex = allReadings.findIndex(
          (r: any) => r.measurementTime === timestamp,
        );
      }

      // Target not found: daily/raw return the full window; 5m returns empty (prior behavior).
      if (targetIndex === -1) return source === "5m" ? [] : allReadings;

      let startIndex = Math.max(0, targetIndex - 5);
      let endIndex = Math.min(allReadings.length, targetIndex + 6);
      if (targetIndex < 5) {
        endIndex = Math.min(allReadings.length, targetIndex + 11);
      }
      if (targetIndex + 6 > allReadings.length) {
        startIndex = Math.max(0, targetIndex - 10);
      }
      return allReadings.slice(startIndex, endIndex);
    };

    const all = await fetchSinglePointReadingsPg({
      systemId,
      pointId,
      source,
      timestamp,
      startDayStr: dailyStartDayStr,
      endDayStr: dailyEndDayStr,
    });
    const readings = centerReadings(all);

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
