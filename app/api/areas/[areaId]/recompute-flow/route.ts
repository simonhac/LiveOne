import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import { requireAuth } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import {
  recomputeFlowMatrixForDay,
  getFirstFlowDay,
} from "@/lib/db/planetscale/flow-matrix-pg";
import { planFlowRecomputeBatch } from "@/lib/aggregation/flow-recompute-batch";
import { getYesterdayInTimezone } from "@/lib/date-utils";

// A batch of up to MAX_LIMIT days runs comfortably inside this; the caller loops for longer ranges.
export const maxDuration = 60;

const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);
const DEFAULT_LIMIT = 14;
const MAX_LIMIT = 31;

/**
 * POST /api/areas/[areaId]/recompute-flow — recompute ONE area's energy-flow matrix
 * (`point_readings_flow_1d`, the Sankey) over a date range, in BOUNDED BATCHES so a long range can't
 * blow the function timeout. Authorized for the area's **owner** or an **admin**.
 *
 * Body (all optional): { start?, end?: "YYYY-MM-DD", last?: "Nd", cursor?: "YYYY-MM-DD", limit?: number }
 *   - range defaults to the system's FIRST data point → yesterday (full history); `last` or
 *     `start`+`end` override it. Processing still runs in bounded batches, newest-first.
 *   - `cursor` = the most-recent day still to do (defaults to `end`); processing runs BACKWARD.
 *   - `limit` = max days this call (default 14, max 31).
 * Returns: { ok, areaId, recomputed, rowsUpserted, from, to, nextCursor, done }.
 * To recompute a whole range, POST once then re-POST with the returned `nextCursor` until `done`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (!planetscaleDb)
    return NextResponse.json({ error: "DB not configured" }, { status: 503 });

  const { areaId } = await params;
  const [area] = await planetscaleDb
    .select({
      ownerClerkUserId: areas.ownerClerkUserId,
      legacySystemId: areas.legacySystemId,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!area)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  const isOwner = !!auth.userId && area.ownerClerkUserId === auth.userId;
  if (!isOwner && !auth.isAdmin)
    return NextResponse.json(
      { error: "Forbidden — area owner or admin only" },
      { status: 403 },
    );
  if (area.legacySystemId == null)
    return NextResponse.json(
      { error: "Area has no system handle" },
      { status: 422 },
    );

  const ls = await resolveLogicalSystem(area.legacySystemId);
  if (!ls)
    return NextResponse.json(
      { error: "Could not resolve the area's logical system" },
      { status: 422 },
    );
  // No complete source+load role set → no Sankey to compute. Not an error; nothing to do.
  if (!ls.isComplete)
    return NextResponse.json({
      ok: true,
      areaId,
      recomputed: 0,
      rowsUpserted: 0,
      done: true,
      note: "area has no complete flow (source + load) to recompute",
    });

  const body = (await request.json().catch(() => ({}))) as {
    start?: string;
    end?: string;
    last?: string;
    cursor?: string;
    limit?: number;
  };

  // Resolve [start, end] (local days in the area's timezone).
  let end = getYesterdayInTimezone(ls.timezoneOffsetMin);
  let start: CalendarDate;
  try {
    if (typeof body.end === "string") end = parseDate(body.end);
    if (typeof body.last === "string") {
      const n = parseInt(body.last.replace("d", ""), 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("bad last");
      start = end.subtract({ days: n - 1 });
    } else if (typeof body.start === "string") {
      start = parseDate(body.start);
    } else {
      // Default: the system's first data point (full history). Falls back to the birthdate when
      // the system has no 5m data yet.
      start = (await getFirstFlowDay(planetscaleDb, ls)) ?? LIVEONE_BIRTHDATE;
    }
  } catch {
    return NextResponse.json(
      {
        error:
          "Invalid date params (start/end/last — expected YYYY-MM-DD / 'Nd')",
      },
      { status: 400 },
    );
  }
  if (start.compare(LIVEONE_BIRTHDATE) < 0) start = LIVEONE_BIRTHDATE;
  if (start.compare(end) > 0)
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 },
    );

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(Number(body.limit) || DEFAULT_LIMIT)),
  );

  // cursor = the most-recent day to process this batch (default end).
  let cursor = end;
  if (typeof body.cursor === "string") {
    try {
      cursor = parseDate(body.cursor);
    } catch {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
  }

  const { days, nextCursor, done } = planFlowRecomputeBatch({
    start,
    end,
    cursor,
    limit,
  });
  let rowsUpserted = 0;
  for (const day of days) {
    const { rowsUpserted: n } = await recomputeFlowMatrixForDay(
      planetscaleDb,
      ls,
      day,
    );
    rowsUpserted += n;
  }

  return NextResponse.json({
    ok: true,
    areaId,
    // The area's handle (legacy_system_id) — the systemId the client's chart/sankey queries are keyed
    // on, so the caller can invalidate exactly this system's cached data after the recompute.
    systemId: area.legacySystemId,
    recomputed: days.length,
    rowsUpserted,
    from: days.length ? days[days.length - 1].toString() : null, // oldest
    to: days.length ? days[0].toString() : null, // newest
    nextCursor: nextCursor ? nextCursor.toString() : null,
    done,
  });
}
