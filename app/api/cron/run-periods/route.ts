import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { parseDate } from "@internationalized/date";
import { getNowFormattedAEST } from "@/lib/date-utils";
import {
  reconcileTrailingWindow,
  recomputeRange,
  deleteRange,
} from "@/lib/run-tracking/recompute";

// Earliest data (when point data collection began) — clamps backfill ranges.
const LIVEONE_BIRTHDATE_MS = Date.parse("2025-08-16T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a [startMs, endMs] range from the request params. Returns null when no range was
 * specified (the no-param cron path → trailing reconcile).
 *
 * - last=Nd            → [now − N days, now]
 * - date=YYYY-MM-DD    → that whole UTC day
 * - start&end=Y-M-D    → [start 00:00Z, end 23:59:59.999Z]
 * - (action, no dates) → [BIRTHDATE, now] (all data)
 */
function parseRange(
  action: string | null,
  last: string | null,
  date: string | null,
  start: string | null,
  end: string | null,
  nowMs: number,
): { startMs: number; endMs: number } | null {
  const specCount = [last, date, start || end].filter(Boolean).length;
  if (specCount > 1) {
    throw new Error(
      "Only one date specification allowed: use 'last', 'date', or 'start+end'",
    );
  }

  let startMs: number;
  let endMs: number;

  if (last) {
    const days = parseInt(last.replace("d", ""), 10);
    if (isNaN(days) || days <= 0) {
      throw new Error("Invalid 'last' parameter. Expected format: '7d'");
    }
    startMs = nowMs - days * DAY_MS;
    endMs = nowMs;
  } else if (date) {
    const d = parseDate(date); // throws on bad format
    startMs = Date.parse(`${d.toString()}T00:00:00Z`);
    endMs = Date.parse(`${d.toString()}T23:59:59.999Z`);
  } else if (start || end) {
    if (!start || !end) {
      throw new Error("Both start and end must be provided together");
    }
    const s = parseDate(start);
    const e = parseDate(end);
    startMs = Date.parse(`${s.toString()}T00:00:00Z`);
    endMs = Date.parse(`${e.toString()}T23:59:59.999Z`);
  } else if (action) {
    // Explicit action, no dates → all data.
    startMs = LIVEONE_BIRTHDATE_MS;
    endMs = nowMs;
  } else {
    return null; // no action, no dates → trailing reconcile
  }

  if (startMs < LIVEONE_BIRTHDATE_MS) startMs = LIVEONE_BIRTHDATE_MS;
  if (startMs > endMs) {
    throw new Error("Start must be before or equal to end");
  }
  return { startMs, endMs };
}

async function handle(request: NextRequest) {
  try {
    const authResult = await requireCronOrAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { searchParams } = new URL(request.url);
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const action = searchParams.get("action") || body.action || null;
    const last = searchParams.get("last") || body.last || null;
    const date = searchParams.get("date") || body.date || null;
    const start = searchParams.get("start") || body.start || null;
    const end = searchParams.get("end") || body.end || null;

    const nowMs = Date.now();
    const startTime = nowMs;

    let range: { startMs: number; endMs: number } | null;
    try {
      range = parseRange(action, last, date, start, end, nowMs);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid date parameters",
        },
        { status: 400 },
      );
    }

    // No action + no range → the default minutely cron pass.
    if (!action && !range) {
      const summary = await reconcileTrailingWindow(nowMs);
      return NextResponse.json({
        success: true,
        action: "reconcile",
        ...summary,
        durationMs: Date.now() - startTime,
        executedAt: getNowFormattedAEST(),
      });
    }

    if (!range) {
      return NextResponse.json(
        { error: "Could not resolve a date range" },
        { status: 400 },
      );
    }

    if (action === "delete") {
      const res = await deleteRange(range.startMs, range.endMs);
      return NextResponse.json({
        success: true,
        action: "delete",
        ...res,
        durationMs: Date.now() - startTime,
        executedAt: getNowFormattedAEST(),
      });
    }

    if (action === "regenerate") {
      const del = await deleteRange(range.startMs, range.endMs);
      const summary = await recomputeRange(range.startMs, range.endMs, nowMs);
      return NextResponse.json({
        success: true,
        action: "regenerate",
        rowsPurged: del.rowsDeleted,
        ...summary,
        durationMs: Date.now() - startTime,
        executedAt: getNowFormattedAEST(),
      });
    }

    if (action === "aggregate") {
      const summary = await recomputeRange(range.startMs, range.endMs, nowMs);
      return NextResponse.json({
        success: true,
        action: "aggregate",
        ...summary,
        durationMs: Date.now() - startTime,
        executedAt: getNowFormattedAEST(),
      });
    }

    return NextResponse.json(
      {
        error:
          "Invalid action. Expected: delete | aggregate | regenerate (with optional date range), or no params for the trailing reconcile",
      },
      { status: 400 },
    );
  } catch (error) {
    console.error("[Cron] Run-period recompute failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
