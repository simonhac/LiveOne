import { NextRequest, NextResponse } from "next/server";
import { loadDerivationForOwner } from "@/lib/derivations/http";
import { RUN_DETECTOR_KIND } from "@/lib/derivations/resolve";
import { derivationWire } from "@/lib/derivations/v4-shapes";
import { getNowFormattedAEST } from "@/lib/date-utils";
import { parseRecomputeRange } from "@/lib/run-tracking/range";
import { deleteRange, recomputeRange } from "@/lib/run-tracking/recompute";

// A multi-week backfill of ONE detector runs comfortably inside this; `recomputeRange` chunks at 14
// days internally, so the caller loops (`--last=30d` slices) for anything longer. Must be declared
// HERE: Next reads `maxDuration` off the route module itself, so re-exporting it from a shared
// implementation would silently leave this address on the 60 s default — the same trap
// `recompute-provenance/route.ts` documents.
export const maxDuration = 300;

/**
 * POST /api/v4/areas/{ar_}/derivations/{dx_}/recompute — rebuild ONE derivation's intervals over a
 * window.
 *
 *   { action: "regenerate" | "delete" | "aggregate", last? | date? | start?+end? } → 200 { … }
 *
 * ## Why this exists when `/api/cron/derivations` already does it
 *
 * 🛑 **The scope is the path.** The cron takes the same actions with an OPTIONAL
 * `derivation=`/`handle=`+`role=` filter, and every one of `regenerate`/`delete` is a
 * delete-and-reinsert — so an unscoped historical call rebuilds every detector in the fleet, and a
 * detector whose signal has since been re-pointed loses the rows its current signal cannot
 * reproduce. That hazard is documented in three places and guarded by none of them; a full-range
 * unscoped regenerate on dev once collapsed 71 rows to 3. Here the derivation is a path segment, so
 * there is no unscoped form to reach for: the dangerous call is not refused, it is unspellable.
 *
 * The cron keeps its filter — it is the minutely trailing reconcile and must run over everything.
 * This is the address a human or the CLI (`liveone derivation recompute`) uses, and it is the v4
 * expression of an operation that previously had none.
 *
 * Range grammar is shared with the cron (`lib/run-tracking/range.ts`), so the two cannot drift on
 * what `end` means or where the floor is. An `action` with no dates means ALL history for this one
 * detector, which is safe precisely because it is one detector.
 *
 * Owner or admin. 400 bad id or bad range · 403 not yours · 404 unknown area/derivation ·
 * 422 wrong kind.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const loaded = await loadDerivationForOwner(request, id, dxid);
  if ("error" in loaded) return loaded.error;
  const { derivation } = loaded;

  // `output='point'` kinds (the HWS model) heal through their own daily pass and
  // scripts/backfill-hws-temperature.ts — they write agg_5m rows, not intervals, so none of the
  // three actions below means anything for them. Refuse rather than reporting a successful no-op.
  if (derivation.kind !== RUN_DETECTOR_KIND)
    return NextResponse.json(
      {
        error: `Only ${RUN_DETECTOR_KIND} derivations produce intervals; this one is '${derivation.kind}'`,
      },
      { status: 422 },
    );

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const action = s(body.action);
  if (action !== "regenerate" && action !== "delete" && action !== "aggregate")
    return NextResponse.json(
      { error: "action must be one of: regenerate | delete | aggregate" },
      { status: 400 },
    );

  const nowMs = Date.now();
  const startedMs = nowMs;
  let range: { startMs: number; endMs: number } | null;
  try {
    range = parseRecomputeRange(
      action,
      {
        last: s(body.last),
        date: s(body.date),
        start: s(body.start),
        end: s(body.end),
      },
      nowMs,
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
  // Unreachable in practice (an action is always present by the check above, and `parseRange`
  // returns a range whenever one is), but the type is nullable and a silent `!` here would be the
  // kind of assumption that stops being true when the grammar grows.
  if (!range)
    return NextResponse.json(
      { error: "Could not resolve a date range" },
      { status: 400 },
    );

  // Echoed on every response, exactly as the cron echoes its resolved scope: "which detector did
  // this touch?" is the question a delete-and-reinsert has to answer out loud, even when the answer
  // is structurally guaranteed.
  const scope = { derivation: derivationWire(derivation) };
  const window = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
  };
  const filter = { derivationId: derivation.id };

  // 🛑 A DISABLED derivation resolves to nothing here. `recomputeRange`/`deleteRange` both go
  // through `listEnabledRunDetectors`, which filters on `enabled` — so a scoped call against a
  // disabled detector reports zeros rather than failing, and that reads as "no data in the window".
  // Say which it was.
  if (!derivation.enabled)
    return NextResponse.json(
      {
        error:
          "This derivation is disabled, and a recompute would silently do nothing — enable it first",
      },
      { status: 422 },
    );

  const done = (extra: object) =>
    NextResponse.json({
      success: true,
      action,
      scope,
      window,
      ...extra,
      durationMs: Date.now() - startedMs,
      executedAt: getNowFormattedAEST(),
    });

  if (action === "delete")
    return done(await deleteRange(range.startMs, range.endMs, filter));

  if (action === "regenerate") {
    const del = await deleteRange(range.startMs, range.endMs, filter);
    const summary = await recomputeRange(range.startMs, range.endMs, nowMs, {
      filter,
    });
    return done({ rowsPurged: del.rowsDeleted, ...summary });
  }

  return done(
    await recomputeRange(range.startMs, range.endMs, nowMs, { filter }),
  );
}
