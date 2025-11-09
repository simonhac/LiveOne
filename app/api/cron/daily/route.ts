import { NextRequest, NextResponse } from "next/server";
import {
  aggregateYesterdayPointsForAllSystems,
  aggregateAllPointsForADay,
  aggregateAllMissingDaysForAllPoints,
  aggregateLastNDaysForAllPoints,
} from "@/lib/db/aggregate-daily-points";
import { db } from "@/lib/db";
import { pointReadingsAgg1d } from "@/lib/db/schema-monitoring-points";
import { validateCronRequest } from "@/lib/cron-utils";
import { parseDateYYYYMMDD } from "@/lib/date-utils";

// This endpoint will be called daily at 00:05 (5 minutes after midnight)
export async function GET(request: NextRequest) {
  try {
    // Validate cron request or admin user
    if (!(await validateCronRequest(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[Cron] Starting daily point aggregation job");
    const startTime = Date.now();

    // Aggregate yesterday's point data for all systems
    const pointsResults = await aggregateYesterdayPointsForAllSystems();

    const duration = Date.now() - startTime;
    console.log(`[Cron] Daily point aggregation completed in ${duration}ms`);

    return NextResponse.json({
      success: true,
      message: `Aggregated points for ${pointsResults.length} systems`,
      pointsResults,
      duration,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron] Daily point aggregation failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// Allow manual triggering with POST (admin only in production)
export async function POST(request: NextRequest) {
  try {
    // Validate request (allows all in dev, requires admin or CRON_SECRET in production)
    if (!(await validateCronRequest(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { action, date } = body;

    // Check if a specific date was provided (YYYYMMDD format)
    if (date) {
      console.log(`[Daily Points] Aggregating specific date: ${date}`);

      // Parse YYYYMMDD to CalendarDate
      const calendarDate = parseDateYYYYMMDD(date);

      // Aggregate points for all systems for this specific date
      const pointsResults = await aggregateAllPointsForADay(calendarDate);

      return NextResponse.json({
        success: true,
        action: "specific-date",
        date,
        ...pointsResults,
        timestamp: new Date().toISOString(),
      });
    }

    if (action === "regenerate") {
      // Clear the entire table and regenerate all historical data
      console.log(
        "[Daily Points] Regenerating all daily point aggregations...",
      );

      // Clear the table
      await db.delete(pointReadingsAgg1d).execute();
      console.log("[Daily Points] Table cleared");

      // Regenerate all missing days for all systems
      const pointsResults = await aggregateAllMissingDaysForAllPoints();

      return NextResponse.json({
        success: true,
        action: "regenerate",
        message: `Regenerated all daily point aggregations`,
        pointsResults,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Default: Update last 7 days for all systems
      console.log(
        "[Daily Points] Updating last 7 days of point aggregations...",
      );

      const pointsResults = await aggregateLastNDaysForAllPoints(7);

      return NextResponse.json({
        success: true,
        action: "update",
        message: `Updated last 7 days for ${pointsResults.length} systems`,
        pointsResults,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("[Cron] Manual point aggregation failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
