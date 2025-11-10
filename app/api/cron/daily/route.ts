import { NextRequest, NextResponse } from "next/server";
import { deleteRange, aggregateRange } from "@/lib/db/aggregate-daily-points";
import { validateCronRequest } from "@/lib/cron-utils";
import { parseDate, CalendarDate } from "@internationalized/date";
import { getNowFormattedAEST, getYesterdayInTimezone } from "@/lib/date-utils";
import { SystemsManager } from "@/lib/systems-manager";

// Earliest date for point data aggregation (when point data collection began)
const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

/**
 * Parse and validate date parameters
 * @param date - Single date parameter (YYYY-MM-DD)
 * @param start - Start date parameter (YYYY-MM-DD)
 * @param end - End date parameter (YYYY-MM-DD)
 * @param last - Last N days parameter (e.g., "7d")
 * @param action - The action being performed (delete/aggregate/regenerate)
 * @param timezoneOffsetMin - Timezone offset for calculating "today/yesterday"
 * @returns Object with parsed start/end dates (clamped to LIVEONE_BIRTHDATE minimum)
 * @throws Error with user-friendly message if validation fails
 */
function parseDateParams(
  date: string | null,
  start: string | null,
  end: string | null,
  last: string | null,
  action: string | null,
  timezoneOffsetMin: number,
): {
  startDate: CalendarDate | null;
  endDate: CalendarDate | null;
} {
  let startDate: CalendarDate | null = null;
  let endDate: CalendarDate | null = null;

  // Check for ambiguous parameter combinations
  const paramCount = [last, date, start || end].filter(Boolean).length;
  if (paramCount > 1) {
    throw new Error(
      "Only one date specification allowed: use 'last', 'date', or 'start+end' (not multiple)",
    );
  }

  // If last parameter is provided (e.g., "7d"), calculate date range
  // Note: Uses yesterday as end date to avoid aggregating incomplete data for today
  if (last) {
    const days = parseInt(last.replace("d", ""), 10);
    if (isNaN(days) || days <= 0) {
      throw new Error("Invalid 'last' parameter. Expected format: '7d'");
    }

    const yesterday = getYesterdayInTimezone(timezoneOffsetMin);
    startDate = yesterday.subtract({ days: days - 1 });
    endDate = yesterday;
  }
  // If date parameter is provided, use it for both start and end
  else if (date) {
    try {
      const calendarDate = parseDate(date);
      startDate = calendarDate;
      endDate = calendarDate;
    } catch (error) {
      throw new Error("Invalid 'date' parameter. Expected format: YYYY-MM-DD");
    }
  }
  // If start or end provided, both must be provided
  else if (start || end) {
    if (!start || !end) {
      throw new Error("Both start and end must be provided together");
    }
    try {
      startDate = parseDate(start);
      endDate = parseDate(end);
    } catch (error) {
      throw new Error(
        "Invalid date format. Expected start and end in YYYY-MM-DD format",
      );
    }
  }
  // No date parameters - default behavior depends on action
  else {
    // For actions with explicit action parameter, operate on all data
    if (
      action === "delete" ||
      action === "aggregate" ||
      action === "regenerate"
    ) {
      return { startDate: null, endDate: null };
    }

    // Default to yesterday for no-action (cron behavior)
    const yesterday = getYesterdayInTimezone(timezoneOffsetMin);
    startDate = yesterday;
    endDate = yesterday;
  }

  // Clamp start date to minimum (when point data collection began)
  if (startDate && startDate.compare(LIVEONE_BIRTHDATE) < 0) {
    console.log(
      `[Daily Points] Clamping start date from ${startDate.toString()} to ${LIVEONE_BIRTHDATE.toString()}`,
    );
    startDate = LIVEONE_BIRTHDATE;
  }

  // Validate date range order (if both provided)
  if (startDate && endDate && startDate.compare(endDate) > 0) {
    throw new Error(
      `Start date ${startDate.toString()} must be before or equal to end date ${endDate.toString()}`,
    );
  }

  return { startDate, endDate };
}

/**
 * Shared aggregation handler for both GET and POST
 *
 * Actions:
 * - action=delete - Delete aggregations
 * - action=aggregate - Create/update aggregations
 * - action=regenerate - Delete then re-aggregate (delete + aggregate)
 * - No action - Aggregate yesterday (default cron behavior)
 *
 * Date range parameters (apply to all actions):
 * - date=YYYY-MM-DD - Specific date
 * - start=YYYY-MM-DD&end=YYYY-MM-DD - Date range
 * - last=7d - Last N days (from today back)
 * - No date params - All available data (or yesterday for default cron)
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

    // Get timezone offset from first system (needed for date calculations)
    const systemsManager = SystemsManager.getInstance();
    const systems = await systemsManager.getActiveSystems();

    if (systems.length === 0) {
      return NextResponse.json({ error: "No systems found" }, { status: 404 });
    }

    const timezoneOffsetMin = systems[0].timezoneOffsetMin;

    // Parse date parameters for all actions (including no action = default cron)
    let parsedDates: {
      startDate: CalendarDate | null;
      endDate: CalendarDate | null;
    };

    try {
      parsedDates = parseDateParams(
        date,
        start,
        end,
        last,
        action,
        timezoneOffsetMin,
      );
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid date parameters",
        },
        { status: 400 },
      );
    }

    // Path 1: action=delete - Delete aggregations
    if (action === "delete") {
      const result = await deleteRange(
        parsedDates.startDate,
        parsedDates.endDate,
      );
      const durationMs = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "delete",
        ...result,
        statistics: {
          rowsDeleted: result.rowsDeleted,
          queryCount: result.queryCount,
          durationMs,
        },
        executedAt: getNowFormattedAEST(),
      });
    }

    // Path 2: action=aggregate or no action - Aggregate data
    // (no action defaults to yesterday, treated as aggregate)
    if (action === "aggregate" || !action) {
      const result = await aggregateRange(
        parsedDates.startDate,
        parsedDates.endDate,
      );
      const durationMs = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: action || "daily",
        ...result,
        statistics: {
          pointsAggregated: result.pointsAggregated,
          rowsCreated: result.rowsCreated,
          queryCount: result.queryCount,
          durationMs,
        },
        executedAt: getNowFormattedAEST(),
      });
    }

    // Path 3: action=regenerate - Delete then re-aggregate
    if (action === "regenerate") {
      // Delete existing aggregations
      const deleteResult = await deleteRange(
        parsedDates.startDate,
        parsedDates.endDate,
      );

      // Regenerate aggregations
      const aggregateResult = await aggregateRange(
        parsedDates.startDate,
        parsedDates.endDate,
      );

      const durationMs = Date.now() - startTime;

      return NextResponse.json({
        success: true,
        action: "regenerate",
        ...aggregateResult,
        statistics: {
          pointsAggregated: aggregateResult.pointsAggregated,
          rowsDeleted: deleteResult.rowsDeleted,
          rowsCreated: aggregateResult.rowsCreated,
          queryCount: deleteResult.queryCount + aggregateResult.queryCount,
          durationMs,
        },
        executedAt: getNowFormattedAEST(),
      });
    }

    // Invalid parameters
    return NextResponse.json(
      {
        error:
          "Invalid parameters. Expected: action (delete/aggregate/regenerate) with optional date range (date=YYYY-MM-DD, start=YYYY-MM-DD&end=YYYY-MM-DD, or last=7d), or no params for daily aggregation",
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
