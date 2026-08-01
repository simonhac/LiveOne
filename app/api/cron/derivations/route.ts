/**
 * The derivations cron — one minutely pass over every kind of derived signal (config-v4 Phase 11).
 *
 * Dispatches by derivation kind: `run-detector` (→ derived_intervals, plus the KV "running" point)
 * then `hws-model` (→ the derived temperature point's agg_5m + KV). HWS used to be hard-wired into
 * the minutely cron; both are now discovered through the same `derivations` table.
 *
 * The explicit range actions (delete | regenerate | aggregate) operate on run-detector intervals,
 * optionally SCOPED to one detector via `derivation=<uuid>` or `handle=<int>&role=<id>` — see
 * `parseFilter`, and scope anything historical. HWS ranges heal through the daily pass and
 * scripts/backfill-hws-temperature.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { parseDate } from "@internationalized/date";
import { getNowFormattedAEST } from "@/lib/date-utils";
import {
  reconcileTrailingWindow,
  recomputeRange,
  deleteRange,
  describeFilter,
} from "@/lib/run-tracking/recompute";
import {
  listEnabledRunDetectors,
  type RunDetectorFilter,
} from "@/lib/derivations/resolve";
import { publishRunningLatest } from "@/lib/run-tracking/running-latest";
import { reconcileTrailingWindow as reconcileHwsTemperature } from "@/lib/hws/recompute";

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

/**
 * Resolve the optional detector SCOPE from the request: `derivation=<uuid>` or
 * `handle=<int>&role=<id>`. Absent → every enabled detector (the historical behaviour, and the only
 * right one for the no-param trailing reconcile).
 *
 * 🛑 An explicit-range action without a scope rebuilds EVERY detector over that range, and the
 * rebuild is delete-and-reinsert — so a detector whose signal has since been re-pointed loses the
 * rows its current signal cannot reproduce. Scope any historical call.
 */
function parseFilter(
  derivation: string | null,
  handleParam: string | null,
  role: string | null,
): RunDetectorFilter | undefined {
  if (derivation) {
    if (handleParam || role)
      throw new Error("Use either 'derivation' or 'handle'+'role', not both");
    return { derivationId: derivation };
  }
  if (!handleParam && !role) return undefined;
  if (!handleParam || !role)
    throw new Error("Both 'handle' and 'role' must be provided together");
  const h = parseInt(handleParam, 10);
  if (isNaN(h)) throw new Error("'handle' must be an integer");
  return { handle: h, role };
}

async function handle(request: NextRequest) {
  try {
    const authResult = await requireCronOrAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    // This route previously had NO kill-switch at all — the only `vercel.json` cron without one. It runs
    // EVERY MINUTE and reads agg_5m through the DAO, which makes it the most likely holder of an
    // ACCESS SHARE lock when the cutover tries to take ACCESS EXCLUSIVE for the rename-swap. It gets both
    // guards: the standing CRONS_ENABLED switch and the cutover window gate.
    const skip = cronSkipReason(request, authResult);
    if (skip) return NextResponse.json(skip);

    const { searchParams } = new URL(request.url);
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const action = searchParams.get("action") || body.action || null;
    const last = searchParams.get("last") || body.last || null;
    const date = searchParams.get("date") || body.date || null;
    const start = searchParams.get("start") || body.start || null;
    const end = searchParams.get("end") || body.end || null;
    const derivation =
      searchParams.get("derivation") || body.derivation || null;
    const handleParam =
      searchParams.get("handle") || body.handle?.toString() || null;
    const role = searchParams.get("role") || body.role || null;

    const nowMs = Date.now();
    const startTime = nowMs;

    let range: { startMs: number; endMs: number } | null;
    let filter: RunDetectorFilter | undefined;
    try {
      range = parseRange(action, last, date, start, end, nowMs);
      filter = parseFilter(derivation, handleParam, role);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid date parameters",
        },
        { status: 400 },
      );
    }

    // The trailing reconcile also publishes the KV "running" points and runs the HWS model, neither
    // of which a detector scope means anything for. Refuse rather than silently ignoring the scope —
    // a typo'd scoped call must not read as a successful narrow pass.
    if (filter && !action && !range) {
      return NextResponse.json(
        {
          error:
            "'derivation'/'handle'+'role' only apply to an explicit action (delete | aggregate | regenerate)",
        },
        { status: 400 },
      );
    }

    // No action + no range → the default minutely cron pass, over every derivation kind.
    if (!action && !range) {
      const summary = await reconcileTrailingWindow(nowMs);
      // Publish each detector's live running state into the KV latest map (derived point) so
      // dashboards read it from /api/data like any other live value. Best-effort.
      let runningPublished = 0;
      try {
        runningPublished = (await publishRunningLatest(nowMs)).updated;
      } catch (err) {
        console.error("[Cron] publishRunningLatest failed:", err);
      }
      // output='point' derivations: the HWS thermal model. Best-effort, same as above — a model
      // failure must not cost us the interval reconcile that already succeeded.
      let hwsPairs = 0;
      let hwsRows = 0;
      try {
        const hws = await reconcileHwsTemperature(nowMs);
        hwsPairs = hws.pairsProcessed;
        hwsRows = hws.rowsWritten;
      } catch (err) {
        console.error("[Cron] HWS temperature reconcile failed:", err);
      }
      return NextResponse.json({
        success: true,
        action: "reconcile",
        ...summary,
        runningPublished,
        hwsPairs,
        hwsRows,
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

    // What the scope actually resolved to, echoed on every ranged response. An unscoped call says
    // so explicitly ("all") rather than omitting the key, because "which detectors did this touch?"
    // is the question a delete-and-reinsert over history has to answer out loud.
    const scope = filter
      ? {
          requested: describeFilter(filter),
          detectors: (await listEnabledRunDetectors(filter)).map((d) => ({
            id: d.id,
            handle: d.legacyHandle,
            role: d.role,
            name: d.name,
          })),
        }
      : { requested: "all" as const };

    if (action === "delete") {
      const res = await deleteRange(range.startMs, range.endMs, filter);
      return NextResponse.json({
        success: true,
        action: "delete",
        scope,
        ...res,
        durationMs: Date.now() - startTime,
        executedAt: getNowFormattedAEST(),
      });
    }

    if (action === "regenerate") {
      const del = await deleteRange(range.startMs, range.endMs, filter);
      const summary = await recomputeRange(range.startMs, range.endMs, nowMs, {
        filter,
      });
      return NextResponse.json({
        success: true,
        action: "regenerate",
        scope,
        rowsPurged: del.rowsDeleted,
        ...summary,
        durationMs: Date.now() - startTime,
        executedAt: getNowFormattedAEST(),
      });
    }

    if (action === "aggregate") {
      const summary = await recomputeRange(range.startMs, range.endMs, nowMs, {
        filter,
      });
      return NextResponse.json({
        success: true,
        action: "aggregate",
        scope,
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
    console.error("[Cron] Derivations recompute failed:", error);
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
