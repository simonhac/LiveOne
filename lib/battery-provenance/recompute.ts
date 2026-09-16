/**
 * Battery-provenance orchestration — the cron-facing layer (mirrors lib/run-tracking/recompute.ts and
 * lib/hws/recompute.ts). Enumerates the battery-bearing Areas and drives the prod driver
 * (recomputeBatteryProvenanceForWindow*) over a trailing window (minutely) or an explicit range (daily
 * heal / backfill), chunked. Best-effort throughout so a fold hiccup never breaks the aggregation it trails.
 */
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { parseDate } from "@internationalized/date";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  devices,
  legacyHandles,
  points,
  pointReadingsFlowAttr1d,
} from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";
import { bindingPoint } from "@/lib/battery-provenance/load";
import {
  FLOW_ATTR_VERSION,
  SETTLEMENT_WINDOW_MS,
  recomputeBatteryProvenanceForWindowBestEffort,
  reconcileFromCheckpointBestEffort,
} from "@/lib/db/planetscale/battery-provenance-pg";
import { learnAllForHandle } from "@/lib/db/planetscale/battery-provenance-daily-pg";
import { listCompleteLogicalSystems } from "@/lib/aggregation/logical-system";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import { getTodayInTimezone } from "@/lib/date-utils";
import type { ProvenanceConfig } from "./types";

/** Minutely trailing window. 12h (> HWS/run-tracking's 6h) because Amber revises hours later and devices
 * can go stale; the recompute extends this back by its own WARMUP_MS to anchor the fold at a reset. */
const DEFAULT_TRAILING_MS = 12 * 60 * 60 * 1000;
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LIVEONE_BIRTHDATE_MS = Date.parse("2025-08-16T00:00:00Z");

/** Trailing settlement window the nightly heal re-materialises contiguously: SETTLEMENT_WINDOW_MS + a
 *  1-day buffer so a day gets one recompute AFTER it crosses the cutoff (→ finalized_at stamped). */
export const REHEAL_TRAILING_MS = SETTLEMENT_WINDOW_MS + 24 * 60 * 60 * 1000;
/** The scattered-backlog ceiling sits this many days back from "today" — biased LATE (≥ every fleet tz's
 *  trailing-oldest day) so the seam OVERLAPS the trailing window (harmless: trailing stamps first) instead
 *  of leaving a multi-tz gap. */
const REHEAL_CEILING_LAG_DAYS = 3;
/**
 * Wall-clock budget for the scattered backlog — the REAL bound on the nightly reheal.
 *
 * A count cap alone could not size the run: the cost of a handle is its SPAN plus a 7-day warm-up,
 * not its number of stale days, so "20 days" meant anything from one warm-up to twenty. Worse, the
 * warm-up is paid per handle per run regardless of how many days come with it — repairing 3 days
 * costs ~10 days of reading and repairing 100 contiguous days costs ~107 — so a small cap is the
 * expensive way to drain a backlog, not the safe one. A version bump makes every stored day stale at
 * once (1058 area-days at the time of writing), which at 20/night is ~53 nights.
 *
 * Same shape as `healStaleAgg1dForDevice`'s deadline. Override with `REHEAL_BUDGET_MS` to measure.
 */
const REHEAL_BUDGET_MS = Number(process.env.REHEAL_BUDGET_MS ?? 60_000);
/**
 * Backstop on the SELECT, not on the work — the deadline decides how much of it gets done. Kept so a
 * pathological backlog cannot return an unbounded row set, and so the oldest-first ordering still has
 * something to order.
 */
const REHEAL_MAX_DAYS_PER_RUN = Number(
  process.env.REHEAL_MAX_DAYS_PER_RUN ?? 500,
);
/**
 * Days per recompute call, so the budget is checkable often enough to MEAN anything.
 *
 * 🛑 A handle's whole stale span used to go in one call, which made the deadline unenforceable: it
 * is checked between calls, so one handle with a long backlog runs to completion no matter what.
 * Measured on the dev mirror against a 60s budget: a single handle's 202-day span took 177s — near
 * enough to blow a 300s function on its own. Chunking makes the bound real.
 *
 * 30 rather than `CHUNK_MS`'s 14: every chunk pays its own 7-day warm-up, so this trades ~19%
 * overhead (7/37) for a granularity that still checks in ~every 25s at the measured ~0.9s/day.
 */
const REHEAL_CHUNK_DAYS = Number(process.env.REHEAL_CHUNK_DAYS ?? 30);

/** All Area handles that have a bound battery (role='battery', metric='power') — the recompute targets. */
export async function listBatteryProvenanceHandles(): Promise<number[]> {
  const db = requirePlanetscaleDb();
  const rows = await db
    .selectDistinct({ handle: legacyHandles.handle })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(
      and(
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    );
  return rows.map((r) => r.handle).filter((h): h is number => h != null);
}

/**
 * Daily: run THE learn (η → C → losses, ordering enforced inside `learnAllForHandle`) for every battery
 * Area — maintain the per-day input cache in `battery_provenance_daily` incrementally and persist the
 * applied per-day params. MUST run BEFORE the blend/rollup recompute (recomputeRange) so that reads
 * fresh, reproducible params via inputs.etaSeries / capacitySeries / chargeEfficiencySeries /
 * idleLossKwhPerDaySeries instead of an in-window bootstrap. Best-effort per handle. `rebuild` forces a
 * from-scratch reduce (full-history activation / deep backfill recovery).
 */
export async function learnForAllHandles(
  nowMs: number,
  opts: { rebuild?: boolean } = {},
): Promise<{ handles: number }> {
  const db = requirePlanetscaleDb();
  const handles = await listBatteryProvenanceHandles();
  for (const handle of handles) {
    try {
      const r = await learnAllForHandle(db, handle, nowMs, opts);
      console.log(
        `[BatProv:learn] handle=${handle} mode=${r.mode} reduced=${r.daysReduced}/${r.daysTotal} ` +
          `etaC=${r.latest.etaC?.toFixed(3) ?? "-"} idle=${r.latest.idleKwhPerDay?.toFixed(2) ?? "-"} ` +
          `C=${r.latest.capacityKwh?.toFixed(1) ?? "-"}`,
      );
    } catch (e) {
      console.error(`[BatProv:learn] failed for handle=${handle}:`, e);
    }
  }
  return { handles: handles.length };
}

type PgDb = ReturnType<typeof requirePlanetscaleDb>;

/**
 * Watermark gate: has the battery INPUT advanced past the last-written blend OUTPUT? Two indexed
 * MAX(interval_end) reads — the battery power point vs a helper blend point. When the blend is already
 * current (idle handle / dead feed), the minutely reconcile can skip the whole ~7.5-day re-fold. Returns
 * false (→ recompute) when there is no battery point or no blend has been written yet.
 */
/**
 * The newest 5m interval-end the fold could possibly have covered at `nowMs` — i.e. the last
 * COMPLETE interval boundary. The receiver writes the IN-PROGRESS bucket (a 10:01 reading creates
 * the row for interval-end 10:05, and `withSuccessorIntervals` the one after), so the raw input
 * watermark runs one bucket ahead of anything a fold windowed to `now` can reach. Comparing the
 * blend against that raw watermark therefore NEVER passes while a feed is live — the skip-guard
 * it was built for was dead code, and the refold ran every minute when a new fold is only even
 * possible once per 5. Clamp the input watermark to this boundary before comparing.
 * Pure; exported for tests.
 */
export function lastCompletableIntervalMs(nowMs: number): number {
  const FIVE_MIN_MS = 5 * 60 * 1000;
  return Math.floor(nowMs / FIVE_MIN_MS) * FIVE_MIN_MS;
}

async function blendIsCurrent(
  db: PgDb,
  handle: number,
  nowMs: number,
): Promise<boolean> {
  const [bat] = await db
    .select({ uid: areaBindings.pointUid })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(
      and(
        eq(legacyHandles.handle, handle),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    )
    .limit(1);
  const [out] = await db
    .select({ uid: areaBindings.pointUid })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    // The "is this a helper device?" test hops the binding's uuid through `points.device_id`
    // (slice E PR 2a). Slice K2 dropped the trailing `devices.rid → systems.id` bridge outright:
    // `devices.vendor` IS the vendor, so the hop was pure overhead, not a source.
    .innerJoin(points, eq(points.id, areaBindings.pointUid))
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(legacyHandles.handle, handle),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "carbon-intensity"),
        eq(devices.vendor, "helper"),
      ),
    )
    .limit(1);
  if (!bat || !out) return false; // no battery, or blend never written → recompute
  // Each binding carries the point's uuid (NOT NULL since 0047), so there is nothing to resolve and
  // no miss branch: the only "no data" outcome left is a genuinely empty agg_5m read below.
  const batPoint = bindingPoint(bat.uid);
  const outPoint = bindingPoint(out.uid);
  const maxes = await ReadingsDao.latestAgg5mIntervalMsForPoints(
    [batPoint, outPoint],
    db,
  );
  const inMax = maxes.get(batPoint) ?? null;
  const outMax = maxes.get(outPoint) ?? null;
  if (inMax == null) return true; // no input data at all → nothing to do
  if (outMax == null) return false; // blend never written → recompute
  // Clamp the input watermark to the last complete boundary — see lastCompletableIntervalMs.
  // Late intra-day revisions BEHIND the watermark are (and always were) invisible to this guard;
  // they heal on the next boundary's refold-from-anchor and at the nightly reheal.
  return outMax >= Math.min(inMax, lastCompletableIntervalMs(nowMs));
}

/** Minutely: keep the last `trailingMs` fresh for every battery Area + refresh the KV latest blend. Skips a
 * handle whose blend is already current (watermark gate) so an idle/dead feed costs 2 MAX reads, not a re-fold. */
export async function reconcileTrailingWindow(
  nowMs: number,
  trailingMs: number = DEFAULT_TRAILING_MS,
  config?: ProvenanceConfig,
): Promise<{
  handles: number;
  skipped: number;
  seeded: number;
  fellBack: number;
}> {
  const db = requirePlanetscaleDb();
  const handles = await listBatteryProvenanceHandles();
  let skipped = 0;
  let seeded = 0;
  let fellBack = 0;
  for (const handle of handles) {
    if (await blendIsCurrent(db, handle, nowMs)) {
      skipped++;
      continue;
    }
    // O(today) checkpoint-seeded reconcile first; ANY guard failure falls back to the unchanged
    // 12h + 7d-warm-up path (this path never writes checkpoints — only the trusted long windows do).
    const r = await reconcileFromCheckpointBestEffort(handle, nowMs, {
      config,
    });
    if (r?.seeded) {
      seeded++;
      continue;
    }
    if (r && !r.seeded)
      console.log(
        `[BatProv] handle=${handle} seeded-reconcile fallback: ${r.reason}`,
      );
    fellBack++;
    await recomputeBatteryProvenanceForWindowBestEffort(
      handle,
      nowMs - trailingMs,
      nowMs,
      { updateLatest: true, config },
    );
  }
  return { handles: handles.length, skipped, seeded, fellBack };
}

export interface RangeChunkInfo {
  handle: number;
  chunkStartMs: number;
  chunkEndMs: number;
}

/**
 * Daily heal / backfill: recompute an explicit range in bounded chunks. Covers EVERY complete logical
 * device — flow_attr_1d is the sole per-(area, day) flow matrix, so the rollup runs energy-only +
 * grid/solar attribution for battery-less Areas as well as the battery blend.
 */
export async function recomputeRange(
  startMs: number,
  endMs: number,
  config?: ProvenanceConfig,
  onChunk?: (info: RangeChunkInfo) => void,
): Promise<void> {
  // The rollup covers EVERY complete logical system, so flow_attr_1d supersedes flow_1d fleet-wide
  // (energy-only + grid/solar attribution for battery-less Areas).
  const handles = (await listCompleteLogicalSystems()).map((ls) => ls.id);
  const start = Math.max(startMs, LIVEONE_BIRTHDATE_MS);
  for (const handle of handles) {
    for (let cs = start; cs < endMs; cs += CHUNK_MS) {
      const ce = Math.min(cs + CHUNK_MS, endMs);
      await recomputeBatteryProvenanceForWindowBestEffort(handle, cs, ce, {
        updateLatest: ce >= endMs, // refresh KV latest only on the final chunk
        writeRollup: true, // the per-day attribution rollup is materialised by the range/daily pass
        writeCheckpoints: true, // the range pass is a TRUSTED checkpoint writer (7d warm-up per chunk)
        config,
      });
      onChunk?.({ handle, chunkStartMs: cs, chunkEndMs: ce });
    }
  }
}

export interface RehealResult {
  /** Area-days actually rebuilt this run. */
  days: number;
  /** Handles actually processed. */
  handles: number;
  /** Area-days the SELECT returned — what this run could have done with unlimited time. */
  selected: number;
  /** Selected days left unhealed because the budget ran out. They roll to the next run. */
  remaining: number;
  /** True when the budget stopped the run before the selection was exhausted. */
  timedOut: boolean;
  /** Wall-clock ms spent rebuilding. */
  elapsedMs: number;
}

/**
 * Bounded, oldest-first reheal of the SCATTERED `point_readings_flow_attr_1d` backlog the contiguous
 * trailing recompute (recomputeRange over the settlement window) can't reach: days OLDER than the window
 * that are still unfinalized (`finalized_at IS NULL`) or carry a stale attribution version
 * (`version < FLOW_ATTR_VERSION`). Recomputing re-materialises the day and — being past the cutoff —
 * stamps `finalized_at`, so each day is handled once and drops out of the backlog.
 *
 * Bounded by a wall-clock BUDGET (REHEAL_BUDGET_MS), checked between handles, with
 * REHEAL_MAX_DAYS_PER_RUN a backstop on the SELECT. Steady-state backlog is ~empty (routine late data
 * is WITHIN the window, handled by the trailing pass). Runs LAST in the daily heal, best-effort — a
 * hiccup here must never roll back the already-committed trailing pass.
 *
 * The result reports SELECTED vs HEALED separately, and whether the budget ran out, so "how far did
 * it get" is answerable from the log line instead of by inference. `scripts/utils/reheal-flow-attr.ts`
 * runs exactly this and prints the same numbers.
 */
export async function rehealStaleAttrDays(
  nowMs: number,
  opts: { limit?: number; budgetMs?: number; now?: () => number } = {},
): Promise<RehealResult> {
  const db = requirePlanetscaleDb();
  const limit = opts.limit ?? REHEAL_MAX_DAYS_PER_RUN;
  const clock = opts.now ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? REHEAL_BUDGET_MS);

  // Representative tz for the ceiling. It's late-biased, so a few hours of inter-area tz difference only
  // widens the (harmless) overlap with the trailing window — it can never open a seam gap.
  const [rep] = await db
    .select({ tz: areas.timezoneOffsetMin })
    .from(areas)
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .limit(1);
  const ceilingDay = getTodayInTimezone(rep?.tz ?? 0)
    .subtract({ days: REHEAL_CEILING_LAG_DAYS })
    .toString();

  const rows = await db
    .selectDistinct({
      handle: legacyHandles.handle,
      tz: areas.timezoneOffsetMin,
      day: pointReadingsFlowAttr1d.day,
    })
    .from(pointReadingsFlowAttr1d)
    .innerJoin(areas, eq(areas.id, pointReadingsFlowAttr1d.areaId))
    .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
    .where(
      and(
        lt(pointReadingsFlowAttr1d.day, ceilingDay),
        or(
          isNull(pointReadingsFlowAttr1d.finalizedAt),
          lt(pointReadingsFlowAttr1d.version, FLOW_ATTR_VERSION),
        ),
      ),
    )
    .orderBy(asc(pointReadingsFlowAttr1d.day))
    .limit(limit);

  if (rows.length === 0)
    return {
      days: 0,
      handles: 0,
      selected: 0,
      remaining: 0,
      timedOut: false,
      elapsedMs: 0,
    };

  // Group the selected days by handle, then recompute each handle's [oldest, newest] span in ONE window
  // call (one 7-day warm-up + fold, vs one per day). After a version bump the oldest-N stale days are
  // contiguous per handle, so the span stays small.
  //
  // `updateLatest` is LEFT OFF — rehealing an old day must not clobber the live KV latest.
  //
  // 🛑 `writeCheckpoints` is ON, and used not to be. The reasoning for leaving it off was that "the
  // O(today) reconcile never reads a checkpoint this old", which is true of
  // `reconcileBatteryProvenanceFromCheckpoint` (the minutely path, which asks as of TODAY) and false
  // of the one that matters here: `tryLoadSeededProvenanceInputs`, the READ path, asks as of the
  // REQUESTED WINDOW's start day (`dayIndexStartingAtOrBefore(targetStartMs)`). `SEED_LOOKBACK_DAYS`
  // is relative to that day, not to now — so a chart of noon three weeks ago seeds from that week's
  // midnight checkpoint and rolls forward, and `MAX_SEED_STALENESS_MS` bounds how stale the ANCHOR is,
  // never how far the fold plays forward (replay from a checkpoint is exact).
  //
  // So a historical day with no checkpoint costs every later request an extra WARMUP_MS (7 days) of
  // agg_5m, forever. That is not hypothetical: a model-version bump distrusts every stored checkpoint
  // at once (1024 days of them, back to 2025-08-17), the nightly trusted writer only covers its ~96h
  // trailing window, and this sweep is the ONLY thing that revisits the rest — so with it off, one
  // bump permanently un-seeds all history. Safe to write here: the window recompute applies the full
  // WARMUP_MS lead-in itself and certifies its own warmth, and the write is already gated on
  // `hasBattery && !config && inputsAreCanonical`, over midnights strictly inside the window.
  const byHandle = new Map<number, { tz: number; days: string[] }>();
  for (const r of rows) {
    if (r.handle == null) continue;
    const g = byHandle.get(r.handle);
    if (g) g.days.push(r.day);
    else byHandle.set(r.handle, { tz: r.tz, days: [r.day] });
  }

  const startedAt = clock();
  let healedDays = 0;
  let timedOut = false;
  // A Set, not a counter incremented after the inner loop: `break outer` skips whatever follows it,
  // so a run stopped mid-handle reported "0 handle(s)" beside a non-zero day count.
  const touched = new Set<number>();

  outer: for (const [handle, { tz, days }] of byHandle) {
    const sorted = [...days].sort();
    for (let i = 0; i < sorted.length; i += REHEAL_CHUNK_DAYS) {
      // 🛑 Checked between CHUNKS, and never before the very first one: a budget already spent on
      // arrival must still make SOME progress, or an over-subscribed run stalls the backlog forever
      // while logging that it was busy. Checking between handles alone did not bound anything — see
      // REHEAL_CHUNK_DAYS.
      if (healedDays > 0 && clock() >= deadline) {
        timedOut = true;
        break outer;
      }
      const chunk = sorted.slice(i, i + REHEAL_CHUNK_DAYS);
      const [winStartSec] = dayToUnixRangeForAggregation(
        parseDate(chunk[0]),
        tz,
      );
      const [, winEndSec] = dayToUnixRangeForAggregation(
        parseDate(chunk[chunk.length - 1]),
        tz,
      );
      await recomputeBatteryProvenanceForWindowBestEffort(
        handle,
        winStartSec * 1000,
        winEndSec * 1000,
        { writeRollup: true, writeCheckpoints: true, nowMs },
      );
      healedDays += chunk.length;
      touched.add(handle);
    }
  }
  return {
    days: healedDays,
    handles: touched.size,
    selected: rows.length,
    remaining: rows.length - healedDays,
    timedOut,
    elapsedMs: clock() - startedAt,
  };
}
