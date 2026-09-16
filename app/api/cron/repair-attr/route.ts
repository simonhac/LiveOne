/**
 * Hourly attribution-backlog sweep: a slice of `rehealStaleAttrDays` on its own schedule.
 *
 * GET /api/cron/repair-attr
 *
 * The same backlog `cron/daily` drains at the end of its run — days older than the settlement window
 * that are unfinalized or carry a stale `FLOW_ATTR_VERSION`. It has its own cron because the nightly
 * pass is the wrong shape for the case that actually matters: a MODEL-VERSION BUMP makes every stored
 * day stale at once (1058 area-days when this was written), and one bounded slice per night drains
 * that over weeks, during which every affected chart serves numbers the bump exists to correct.
 *
 * Hourly × a small budget is strictly better than nightly × a large one. The work is idempotent,
 * oldest-first and resumable, so 24 small bites beat one big one: the same daily throughput arrives
 * ~24× sooner after a bump, no single invocation goes near its function limit, and in steady state
 * (an empty backlog) every run is one cheap SELECT that returns nothing.
 *
 * Query: ?budget=<ms> (override the per-run wall clock), ?limit=<n> (SELECT backstop),
 * ?force=true (bypass the CRONS_ENABLED kill-switch for a manual run).
 *
 * 🛑 Deliberately NOT sharing `cron/daily`'s slot: the daily run already uses ~149s of its 300s
 * budget before the reheal starts, so anything given to the backlog there competes with the
 * contiguous pass that keeps TODAY correct. Here it competes with nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { planetscaleDb } from "@/lib/db/planetscale";
import { rehealStaleAttrDays } from "@/lib/battery-provenance/recompute";

export const maxDuration = 300;

/** Per-run wall clock. Well inside `maxDuration`: the sweep finishes its in-flight chunk before
 *  stopping, and a chunk costs ~25s at the measured ~0.8s/day. */
const DEFAULT_BUDGET_MS = 120_000;

export async function GET(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const skip = cronSkipReason(request, auth);
  if (skip) return NextResponse.json(skip);

  if (!planetscaleDb) return NextResponse.json({ configured: false });

  const params = request.nextUrl.searchParams;
  const num = (k: string) => {
    const v = params.get(k);
    return v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };

  const startedAt = Date.now();
  const result = await rehealStaleAttrDays(startedAt, {
    budgetMs: num("budget") ?? DEFAULT_BUDGET_MS,
    limit: num("limit"),
  });

  if (result.selected > 0)
    console.log(
      `[RepairAttr] healed ${result.days}/${result.selected} day(s) across ` +
        `${result.handles} handle(s) in ${result.elapsedMs}ms` +
        (result.timedOut
          ? ` — budget spent, ${result.remaining} roll to the next run`
          : " — selection exhausted"),
    );

  return NextResponse.json({
    configured: true,
    now: new Date().toISOString(),
    ...result,
  });
}
