import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import { getAuthContext } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { planFlowRecomputeBatch } from "@/lib/aggregation/flow-recompute-batch";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import { getYesterdayInTimezone } from "@/lib/date-utils";
import {
  learnAndPersistEta,
  learnAndPersistCapacity,
  recomputeBatteryProvenanceForWindow,
} from "@/lib/db/planetscale/battery-provenance-pg";

// A batch of up to MAX_LIMIT days runs comfortably inside this; the caller loops for longer ranges.
export const maxDuration = 60;

const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);
const DEFAULT_LIMIT = 14;
const MAX_LIMIT = 31;

/**
 * POST /api/areas/[areaId]/recompute-provenance — materialise ONE battery Area's provenance over a date
 * range: the learned η (`bidi.battery/round-trip-efficiency`), the 3 blend points, and the
 * `point_readings_flow_attr_1d` rollup. Runs in BOUNDED BATCHES (mirrors `recompute-flow`) so a long range
 * can't blow the function timeout. This is the API path for activating an Area's battery-provenance (e.g. a
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

  // Provenance only exists for an Area with a bound battery.
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
  if (!bat)
    return NextResponse.json(
      { error: "Area has no bound battery (role=battery, metric=power)" },
      { status: 422 },
    );

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

  // First batch: (re)learn η(t) THEN usable capacity C(t) from the fixed anchor so the recompute below reads
  // a reproducible η + C (via inputs.etaSeries / inputs.capacitySeries) instead of a per-batch, window-
  // dependent bootstrap that would make stored-energy/blend discontinuous at batch seams. C follows η (its
  // deliverable slope reads the learned η) — mirrors the daily shell + backfill ordering.
  let learnedEtaDays: number | null = null;
  if (isFirstBatch) {
    const r = await learnAndPersistEta(planetscaleDb, handle, Date.now());
    learnedEtaDays = r.daysWritten;
    await learnAndPersistCapacity(planetscaleDb, handle, Date.now());
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
      { writeRollup: true, updateLatest: isFirstBatch },
    );
    rowsWritten = res.rowsWritten;
    attrRows = res.attrRowsWritten;
  }

  return NextResponse.json({
    ok: true,
    areaId,
    systemId: handle,
    learnedEtaDays,
    recomputed: days.length,
    rowsWritten,
    attrRows,
    from: days.length ? days[days.length - 1].toString() : null, // oldest
    to: days.length ? days[0].toString() : null, // newest
    nextCursor: nextCursor ? nextCursor.toString() : null,
    done,
  });
}
