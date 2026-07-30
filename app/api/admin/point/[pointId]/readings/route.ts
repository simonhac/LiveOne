import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { decodeUrlDateToEpoch, decodeUrlOffset } from "@/lib/url-date";
import { formatDateYYYYMMDD, parseDateYYYYMMDD } from "@/lib/date-utils";
import { ReadingsDao } from "@/lib/readings/dao";
import { Point } from "@/lib/ids";
import { UnknownIdError } from "@/lib/registry";

/**
 * GET /api/admin/point/{pt_…}/readings — a centred window of readings around one instant.
 *
 * The URL segment WAS the legacy `"{systemId}.{pointIndex}"` address, split and `parseInt`ed and then
 * resolved through `RegistryCache.pointForAddr`. That made this route the last production caller of
 * that grammar — and unfixable later, because `points` has no counterpart to `point_info.index`, so
 * the terminal `point_info` drop would have left nothing to resolve the segment against.
 *
 * It is now the point's `pt_` TypeID, which is the locked public ID scheme AND already exactly the
 * `PointId` the readings seam is keyed on. So there is no registry round trip left here at all: parse,
 * and hand the branded id straight to the DAO.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ pointId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { pointId: pointIdParam } = await params;
    const { searchParams } = new URL(request.url);

    const parsed = Point.parse(pointIdParam);
    if (!parsed.ok) {
      return NextResponse.json(
        {
          error: `Invalid point id (expected a pt_ TypeID): ${parsed.message}`,
        },
        { status: 400 },
      );
    }
    const point = parsed.id;

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

    // Serve the window from Postgres.
    let dailyStartDayStr: string | undefined;
    let dailyEndDayStr: string | undefined;
    if (source === "daily") {
      // targetDate is guaranteed to be non-null by validation above.
      // Fetch wider range: 9 days before and 9 days after.
      const date = parseDateYYYYMMDD(targetDate!);
      dailyStartDayStr = formatDateYYYYMMDD(date.subtract({ days: 9 }));
      dailyEndDayStr = formatDateYYYYMMDD(date.add({ days: 9 }));
    }

    // Center the window on the target row (±5, widening to ±10 at the edges). Pure.
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

    // Serve the window from Postgres. The `UnknownIdError` catch is NOT vestigial: a well-formed `pt_`
    // id for a point that has no registry row still throws from inside the DAO's own PointId→rid
    // resolution (`RegistryCache.addrsForPoints`), so it is what turns "no such point" into the empty
    // window the legacy 0-row query produced. Verified by driving a syntactically valid, non-existent
    // `pt_` id against dev: without this it is a 500.
    let all: any[] = [];
    try {
      if (source === "daily") {
        const series = await ReadingsDao.read1d([point], {
          startDay: dailyStartDayStr!,
          endDay: dailyEndDayStr!,
        });
        all = (series.get(point) ?? []).map((r) => ({
          date: r.day,
          avg: r.avg,
          min: r.min,
          max: r.max,
          last: r.last,
          delta: r.delta,
          sampleCount: r.sampleCount,
          errorCount: r.errorCount,
        }));
      } else if (source === "5m") {
        all = await ReadingsDao.read5mRowWindowAround(point, timestamp!);
      } else {
        all = await ReadingsDao.readRawWindowAround(point, timestamp!);
      }
    } catch (e) {
      if (!(e instanceof UnknownIdError)) throw e;
    }
    const readings = centerReadings(all);

    return NextResponse.json({
      readings,
      metadata: {
        point,
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
