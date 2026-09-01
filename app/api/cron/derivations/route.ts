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
import { getNowFormattedAEST } from "@/lib/date-utils";
import { parseRecomputeRange } from "@/lib/run-tracking/range";
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
import {
  evaluateAutomations,
  type AutomationsSummary,
} from "@/lib/automations/evaluate";

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
      range = parseRecomputeRange(action, { last, date, start, end }, nowMs);
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
      // Charge-limit automations: evaluate against the intervals the reconcile above just
      // refreshed, so a derivation-sourced limit reads an open run that is as of THIS minute.
      // Best-effort like the two steps before it — and `null` rather than zeros when the step
      // itself failed, so a broken evaluator is distinguishable from an idle one.
      let automations: AutomationsSummary | null = null;
      try {
        automations = await evaluateAutomations(nowMs);
      } catch (err) {
        console.error("[Cron] automation evaluation failed:", err);
      }
      return NextResponse.json({
        success: true,
        action: "reconcile",
        ...summary,
        runningPublished,
        hwsPairs,
        hwsRows,
        automations,
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
