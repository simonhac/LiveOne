/**
 * Weekly coverage-repair cron (all re-fetchable external vendors: Amber, OpenElectricity, Sigenergy).
 *
 * GET /api/cron/repair-coverage
 *
 * A two-stage job (see lib/coverage/): Stage 1 finds coverage gaps in the 7–90-day window per vendor;
 * Stage 2 backfills each gap-day by re-fetching from the vendor API (publish → receiver → agg_5m),
 * then waits for the writes to land, recomputes scoped derived tables (agg_1d + area flow/provenance),
 * and posts an itemised report to the monitor channel (OBSERVATIONS_ALERT_WEBHOOK_URL).
 *
 * Query: ?dry=true (Stage-1 only, no writes), ?vendor=<amber|openelectricity|sigenergy> (target one),
 * ?force=true (bypass the CRONS_ENABLED kill-switch for a manual run). Read-only detection; writes only
 * via the existing publish path. Config: REPAIR_MAX_DAYS_PER_RUN (120/vendor), REPAIR_LANDING_WAIT_SECONDS.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { planetscaleDb } from "@/lib/db/planetscale";
import { runCoverageRepair } from "@/lib/coverage/runner";

export const maxDuration = 300;

/**
 * Weekday (UTC, 0=Sunday) on which the nightly run sweeps each provider's full window instead of
 * the shallow one. Monday, matching the slot this cron used to occupy when it ran weekly.
 */
const DEEP_SWEEP_UTC_DAY = 1;

/** Send a Slack-compatible message to the monitor channel. Best-effort; never throws. */
async function postToMonitor(text: string): Promise<boolean> {
  const url = process.env.OBSERVATIONS_ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch (err) {
    console.error("[RepairCoverage] monitor webhook failed:", err);
    return false;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const skip = cronSkipReason(request, auth);
  if (skip) return NextResponse.json(skip);

  if (!planetscaleDb) return NextResponse.json({ configured: false });

  const dryRun =
    process.env.REPAIR_DRY_RUN === "true" ||
    request.nextUrl.searchParams.get("dry") === "true";
  const onlyVendor = request.nextUrl.searchParams.get("vendor") || undefined;

  // Shallow nightly, deep weekly — one schedule, not two. The depth is chosen from the weekday
  // rather than from a second cron entry with `?deep=true`, because a Vercel cron `path` carrying a
  // query string is not something this repo relies on anywhere else, and a route that decides for
  // itself is testable without deploying. `?deep=true` / `?lookback=N` still override, for manual
  // runs.
  //
  // Why not deep every night: nothing records that a gap has been accepted, so a nightly full
  // 90-day sweep re-fetches every permanently-unrecoverable day, every night, against a
  // per-vendor budget inside a 300 s function. See `lib/coverage/runner.ts`.
  const params = request.nextUrl.searchParams;
  const lookbackParam = params.get("lookback");
  const lookbackDays =
    lookbackParam != null && Number.isFinite(Number(lookbackParam))
      ? Number(lookbackParam)
      : undefined;
  const deep =
    params.get("deep") === "true" ||
    (params.get("deep") == null &&
      lookbackDays === undefined &&
      new Date().getUTCDay() === DEEP_SWEEP_UTC_DAY);

  const result = await runCoverageRepair(planetscaleDb, {
    dryRun,
    onlyVendor,
    deep,
    lookbackDays,
  });

  if (result.status === "alert")
    console.error(`[RepairCoverage] ${result.reportText}`);
  const posted = await postToMonitor(result.reportText);

  return NextResponse.json({
    configured: true,
    now: new Date().toISOString(),
    monitorPosted: posted,
    deep,
    ...result,
  });
}
