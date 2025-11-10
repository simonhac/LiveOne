import { NextRequest, NextResponse } from "next/server";
import {
  aggregateDaily,
  regenerateDate,
  regenerateLastNDays,
  deleteRange,
  aggregateRange,
} from "@/lib/db/aggregate-daily-points";
import { validateCronRequest } from "@/lib/cron-utils";
import { parseDate, CalendarDate } from "@internationalized/date";

/**
 * Shared aggregation handler for both GET and POST
 * Supports the following paths:
 * 1. action=delete&start=YYYY-MM-DD&end=YYYY-MM-DD - Delete aggregations for date range
 * 2. action=delete (no start/end) - Delete all aggregations
 * 3. action=aggregate&start=YYYY-MM-DD&end=YYYY-MM-DD - Aggregate date range
 * 4. action=aggregate (no start/end) - Aggregate all available data
 * 5. action=regenerate&last=7d - Delete and regenerate last N days (legacy)
 * 6. action=regenerate&date=YYYY-MM-DD - Delete and regenerate specific date (legacy)
 * 7. No parameters - Aggregate yesterday (default cron behavior)
 */
async function handleAggregation(request: NextRequest) {
  try {
    // Validate cron request or admin user
    if (!(await validateCronRequest(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Extract parameters from query params (GET) or body (POST)
    const { searchParams } = new URL(request.url);
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};

    const action = searchParams.get("action") || body.action;
    const last = searchParams.get("last") || body.last;
    const date = searchParams.get("date") || body.date;
    const start = searchParams.get("start") || body.start;
    const end = searchParams.get("end") || body.end;

    const startTime = Date.now();

    // Path 1: action=delete - Delete aggregations for date range
    if (action === "delete") {
      let startDate: CalendarDate | null = null;
      let endDate: CalendarDate | null = null;

      // Parse start and end dates if provided
      if (start && end) {
        try {
          startDate = parseDate(start);
          endDate = parseDate(end);
        } catch (error) {
          return NextResponse.json(
            {
              error:
                "Invalid date format. Expected start and end in YYYY-MM-DD format",
            },
            { status: 400 },
          );
        }
      } else if (start || end) {
        return NextResponse.json(
          { error: "Both start and end must be provided, or both omitted" },
          { status: 400 },
        );
      }

      const result = await deleteRange(startDate, endDate);
      const duration = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "delete",
        ...result,
        duration,
        timestamp: new Date().toISOString(),
      });
    }

    // Path 2: action=aggregate - Aggregate data for date range
    if (action === "aggregate") {
      let startDate: CalendarDate | null = null;
      let endDate: CalendarDate | null = null;

      // Parse start and end dates if provided
      if (start && end) {
        try {
          startDate = parseDate(start);
          endDate = parseDate(end);
        } catch (error) {
          return NextResponse.json(
            {
              error:
                "Invalid date format. Expected start and end in YYYY-MM-DD format",
            },
            { status: 400 },
          );
        }
      } else if (start || end) {
        return NextResponse.json(
          { error: "Both start and end must be provided, or both omitted" },
          { status: 400 },
        );
      }

      const result = await aggregateRange(startDate, endDate);
      const duration = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "aggregate",
        ...result,
        duration,
        timestamp: new Date().toISOString(),
      });
    }

    // Path 3a: action=regenerate&last=7d (or any number of days) - LEGACY
    if (action === "regenerate" && last) {
      const days = parseInt(last.replace("d", ""), 10);
      if (isNaN(days) || days <= 0) {
        return NextResponse.json(
          { error: "Invalid 'last' parameter. Expected format: '7d'" },
          { status: 400 },
        );
      }

      const results = await regenerateLastNDays(days);
      const duration = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "regenerate-last-n-days",
        last: `${days}d`,
        message: `Regenerated last ${days} days for ${results.length} systems`,
        results,
        duration,
        timestamp: new Date().toISOString(),
      });
    }

    // Path 3b: action=regenerate&date=YYYY-MM-DD - LEGACY
    if (action === "regenerate" && date) {
      // Parse YYYY-MM-DD to CalendarDate
      let calendarDate;
      try {
        calendarDate = parseDate(date);
      } catch (error) {
        return NextResponse.json(
          { error: "Invalid 'date' parameter. Expected format: YYYY-MM-DD" },
          { status: 400 },
        );
      }

      const result = await regenerateDate(calendarDate);
      const duration = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "regenerate-date",
        ...result,
        duration,
        timestamp: new Date().toISOString(),
      });
    }

    // Path 4: No parameters - Default daily aggregation (aggregate yesterday)
    if (!action && !last && !date && !start && !end) {
      const results = await aggregateDaily();
      const duration = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "daily",
        message: `Aggregated yesterday's points for ${results.length} systems`,
        results,
        duration,
        timestamp: new Date().toISOString(),
      });
    }

    // Invalid parameters
    return NextResponse.json(
      {
        error:
          "Invalid parameters. Expected: 'action=delete[&start=YYYY-MM-DD&end=YYYY-MM-DD]', 'action=aggregate[&start=YYYY-MM-DD&end=YYYY-MM-DD]', 'action=regenerate&last=7d', 'action=regenerate&date=YYYY-MM-DD', or no params for daily aggregation",
      },
      { status: 400 },
    );
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

// This endpoint will be called daily at 00:05 (5 minutes after midnight)
export async function GET(request: NextRequest) {
  return handleAggregation(request);
}

// Allow manual triggering with POST (same functionality as GET)
export async function POST(request: NextRequest) {
  return handleAggregation(request);
}
