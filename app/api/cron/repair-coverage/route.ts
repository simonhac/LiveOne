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

  const result = await runCoverageRepair(planetscaleDb, { dryRun, onlyVendor });

  if (result.status === "alert")
    console.error(`[RepairCoverage] ${result.reportText}`);
  const posted = await postToMonitor(result.reportText);

  return NextResponse.json({
    configured: true,
    now: new Date().toISOString(),
    monitorPosted: posted,
    ...result,
  });
}
