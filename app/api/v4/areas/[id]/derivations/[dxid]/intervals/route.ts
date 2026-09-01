import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { loadDerivationForOwner } from "@/lib/derivations/http";
import { derivationWire } from "@/lib/derivations/v4-shapes";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivedIntervals } from "@/lib/db/planetscale/schema";
import { parseRecomputeRange } from "@/lib/run-tracking/range";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/**
 * GET /api/v4/areas/{ar_}/derivations/{dx_}/intervals — the rows a derivation has produced.
 *
 *   ?last=30d | ?date=YYYY-MM-DD | ?start=&end=   ·   ?limit= (≤500) ?offset=
 *   → 200 { derivation, window, count, hasMore, intervals: [...] }
 *
 * Newest first, and bounded: `derived_intervals` is small per detector but unbounded over time, and
 * an operator read that silently returned a year would be the wrong default for both the wire and
 * the terminal.
 *
 * ## Why this is not `/api/device/{handle}/run-periods`
 *
 * That route exists and serves the same table, but it is the DASHBOARD CARD's endpoint: keyed by the
 * legacy integer handle rather than a TypeID, resolving the detector by (handle, role) rather than
 * by identity, and — decisively — serving DISPLAY STRINGS. It returns `date: "Sat 30 Aug"`,
 * `startTime: "4:16pm"`, pre-formatted in the device's display timezone, alongside a server-computed
 * `columns` plan telling the client which cells to render. That is exactly right for the card and
 * exactly wrong for anything that wants to compute: a caller cannot sum a duration it was handed as
 * "4:16pm", and re-parsing a localised string to get back the instant the server already had is how
 * timezone bugs are born.
 *
 * So this serves the ROW: ISO instants, numbers, and the unit each number is in. Formatting is the
 * client's job. The card keeps its own endpoint until it is migrated, which is a separate change —
 * this is not a second implementation of that route's shape, it is the shape that route wraps.
 *
 * Owner or admin. 400 bad id or bad range · 403 not yours · 404 unknown area/derivation.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const loaded = await loadDerivationForOwner(request, id, dxid);
  if ("error" in loaded) return loaded.error;
  const { derivation } = loaded;

  const { searchParams } = new URL(request.url);
  const int = (name: string, fallback: number): number | null => {
    const raw = searchParams.get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const limit = int("limit", DEFAULT_LIMIT);
  const offset = int("offset", 0);
  if (limit === null || offset === null)
    return NextResponse.json(
      { error: "limit and offset must be non-negative integers" },
      { status: 400 },
    );
  if (limit > MAX_LIMIT)
    return NextResponse.json(
      { error: `limit must be ${MAX_LIMIT} or less` },
      { status: 400 },
    );

  // The same window grammar as `…/recompute`, so "which rows did that rebuild write" is asked with
  // the flags that wrote them. Passing a truthy `action` makes an omitted window mean ALL history
  // (bounded by `limit` regardless) rather than null.
  let range: { startMs: number; endMs: number } | null;
  try {
    range = parseRecomputeRange(
      "list",
      {
        last: searchParams.get("last"),
        date: searchParams.get("date"),
        start: searchParams.get("start"),
        end: searchParams.get("end"),
      },
      Date.now(),
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

  // Windowed on `start_time`, matching `deleteRange` — a run is IN a window if it STARTED in it, so
  // the rows this returns are exactly the rows a recompute over the same window would replace.
  const conds = [eq(derivedIntervals.derivationId, derivation.id)];
  if (range) {
    conds.push(gte(derivedIntervals.startTime, new Date(range.startMs)));
    conds.push(lte(derivedIntervals.startTime, new Date(range.endMs)));
  }

  // One extra row is the `hasMore` probe — cheaper and more honest than a COUNT(*) that would race
  // the minutely reconcile writing into the same window.
  const rows = await requirePlanetscaleDb()
    .select()
    .from(derivedIntervals)
    .where(and(...conds))
    .orderBy(desc(derivedIntervals.startTime))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    derivation: derivationWire(derivation),
    window: range
      ? {
          start: new Date(range.startMs).toISOString(),
          end: new Date(range.endMs).toISOString(),
        }
      : null,
    count: page.length,
    hasMore,
    intervals: page.map((r) => ({
      startTime: r.startTime.toISOString(),
      // null = OPEN (running now) — a fact about the row, not a missing value.
      endTime: r.endTime ? r.endTime.toISOString() : null,
      durationSeconds: r.durationSeconds,
      energyKwh: r.energyKwh,
      estimatedKwh: r.estimatedKwh,
      maxSignal: r.maxSignal,
      minSignal: r.minSignal,
      avgSignal: r.avgSignal,
      // Per ROW, not per response: one window can straddle a detector re-point and hold both units
      // (prod's Daylesford history is permanently mixed W/rpm). A response-level unit would be a
      // confident lie about 74 of 77 rows.
      signalUnit: r.signalUnit,
      costC: r.costC,
      emissionsG: r.emissionsG,
      renewableKwh: r.renewableKwh,
      sampleCount: r.sampleCount,
      detectorVersion: r.detectorVersion,
    })),
  });
}
