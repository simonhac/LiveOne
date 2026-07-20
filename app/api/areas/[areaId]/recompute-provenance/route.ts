import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import { getAuthContext } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { planFlowRecomputeBatch } from "@/lib/aggregation/flow-recompute-batch";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import { getYesterdayInTimezone } from "@/lib/date-utils";
import { recomputeBatteryProvenanceForWindow } from "@/lib/db/planetscale/battery-provenance-pg";
import { learnAllForHandle } from "@/lib/db/planetscale/battery-provenance-daily-pg";

// A batch of up to MAX_LIMIT days runs comfortably inside this; the caller loops for longer ranges.
// 300 (not 60): the first batch's learn REDUCES full history from agg_5m on a rebuild (one bounded
// read, ~380k rows) — incremental runs are far faster, this is headroom for the activation path.
export const maxDuration = 300;

const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);
const DEFAULT_LIMIT = 14;
const MAX_LIMIT = 31;

/**
 * POST /api/areas/[areaId]/recompute-provenance — materialise ONE Area's `point_readings_flow_attr_1d`
 * rollup (the sole flow/Sankey matrix) over a date range: energy + grid/solar attribution for ANY
 * complete Area, PLUS the battery blend (learned η `bidi.battery/round-trip-efficiency` + the 3 blend
 * points) when a battery is bound. Runs in BOUNDED BATCHES so a long range can't blow the function
 * timeout. This is the API path for activating/recomputing an Area's Sankey + battery-provenance (e.g. a
 * newly-bound off-grid site) WITHOUT direct DB access — helper device + blend points are ensured on demand.
 * Authorized for the area's **owner** or an **admin**.
 *
 * On the FIRST batch (no `cursor`) it (re)learns + persists η(t) from the fixed anchor BEFORE recomputing,
 * so every batch reads the same reproducible η. Body (all optional):
 *   { start?, end?: "YYYY-MM-DD", last?: "Nd", cursor?: "YYYY-MM-DD", limit?: number }
 *   - range defaults to the LiveOne birthdate → yesterday (full history); `last` / `start`+`end` override.
 * Loop: POST, then re-POST with the returned `nextCursor` until `done`.
 *
 * Authorized for the area's **owner**, an **admin**, or a **`CRON_SECRET` bearer** (headless ops —
 * e.g. re-materialising a single day from a script/curl without the browser/JWT dance).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const auth = await getAuthContext(request);
  // Owner/admin via a Clerk session, or a headless CRON_SECRET bearer. Reject pure anon early.
  if (!auth.userId && !auth.isCron)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!planetscaleDb)
    return NextResponse.json({ error: "DB not configured" }, { status: 503 });

  const { areaId } = await params;
  const [area] = await planetscaleDb
    .select({
      ownerClerkUserId: areas.ownerClerkUserId,
      legacySystemId: areas.legacySystemId,
      tz: areas.timezoneOffsetMin,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!area)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  const isOwner = !!auth.userId && area.ownerClerkUserId === auth.userId;
  if (!auth.isCron && !auth.isAdmin && !isOwner)
    return NextResponse.json(
      { error: "Forbidden — area owner, admin, or cron only" },
      { status: 403 },
    );
  if (area.legacySystemId == null)
    return NextResponse.json(
      { error: "Area has no system handle" },
      { status: 422 },
    );
  const handle = area.legacySystemId;
  const tz = area.tz;

  // flow_attr_1d (the sole flow/Sankey matrix) covers battery AND battery-less complete Areas: energy +
  // grid/solar attribution always, the battery blend only when a battery is bound. Detect a bound
  // battery to decide whether to run the battery-only learn below — a battery-less Area still gets its
  // energy/attribution rollup written (the daily cron already materialises these; this route lets the
  // "Recompute" button do the same on demand rather than 422'ing).
  const [bat] = await planetscaleDb
    .select({ id: areaBindings.id })
    .from(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, areaId),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    )
    .limit(1);
  const hasBattery = !!bat;

  const body = (await request.json().catch(() => ({}))) as {
    start?: string;
    end?: string;
    last?: string;
    cursor?: string;
    limit?: number;
  };

  // Resolve [start, end] as local days in the area's timezone.
  let end = getYesterdayInTimezone(tz);
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
      start = LIVEONE_BIRTHDATE; // full history
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

  let cursor = end;
  if (typeof body.cursor === "string") {
    try {
      cursor = parseDate(body.cursor);
    } catch {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
  }
  const isFirstBatch = typeof body.cursor !== "string";

  // First batch: run THE learn (η → C → losses over the battery_provenance_daily cache) so every batch
  // below reads the same reproducible params (via inputs.etaSeries / capacitySeries /
  // chargeEfficiencySeries / idleLossKwhPerDaySeries) instead of a per-batch, window-dependent
  // bootstrap that would make stored-energy/blend discontinuous at batch seams. A FULL-HISTORY request
  // (no start/last — the activation path) forces a from-scratch rebuild of the input cache; bounded
  // reruns maintain it incrementally.
  let learnedEtaDays: number | null = null;
  let learnMode: string | null = null;
  let reducedDays: number | null = null;
  if (isFirstBatch && hasBattery) {
    const isFullHistory =
      typeof body.start !== "string" && typeof body.last !== "string";
    const r = await learnAllForHandle(planetscaleDb, handle, Date.now(), {
      rebuild: isFullHistory,
    });
    learnedEtaDays = r.etaDays;
    learnMode = r.mode;
    reducedDays = r.daysReduced;
  }

  const { days, nextCursor, done } = planFlowRecomputeBatch({
    start,
    end,
    cursor,
    limit,
  });

  let rowsWritten = 0;
  let attrRows = 0;
  if (days.length > 0) {
    const oldest = days[days.length - 1];
    const newest = days[0];
    const [winStartSec] = dayToUnixRangeForAggregation(oldest, tz);
    const [, winEndSec] = dayToUnixRangeForAggregation(newest, tz);
    const res = await recomputeBatteryProvenanceForWindow(
      planetscaleDb,
      handle,
      winStartSec * 1000,
      winEndSec * 1000,
      // This route is a TRUSTED checkpoint writer (7d warm-up per batch, canonical params from the
      // first-batch learn above).
      { writeRollup: true, updateLatest: isFirstBatch, writeCheckpoints: true },
    );
    rowsWritten = res.rowsWritten;
    attrRows = res.attrRowsWritten;
  }

  return NextResponse.json({
    ok: true,
    areaId,
    systemId: handle,
    learnedEtaDays,
    learnMode,
    reducedDays,
    recomputed: days.length,
    rowsWritten,
    attrRows,
    from: days.length ? days[days.length - 1].toString() : null, // oldest
    to: days.length ? days[0].toString() : null, // newest
    nextCursor: nextCursor ? nextCursor.toString() : null,
    done,
  });
}
