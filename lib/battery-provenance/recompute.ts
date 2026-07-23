/**
 * Battery-provenance orchestration — the cron-facing layer (mirrors lib/run-tracking/recompute.ts and
 * lib/hws/recompute.ts). Enumerates the battery-bearing Areas and drives the prod driver
 * (recomputeBatteryProvenanceForWindow*) over a trailing window (minutely) or an explicit range (daily
 * heal / backfill), chunked. Best-effort throughout so a fold hiccup never breaks the aggregation it trails.
 */
import { and, asc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { parseDate } from "@internationalized/date";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  systems,
  pointReadingsFlowAttr1d,
} from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";
import { RegistryCache, UnknownIdError } from "@/lib/registry";
import type { PointId } from "@/lib/ids";
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
export const DEFAULT_TRAILING_MS = 12 * 60 * 60 * 1000;
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LIVEONE_BIRTHDATE_MS = Date.parse("2025-08-16T00:00:00Z");

/** Trailing settlement window the nightly heal re-materialises contiguously: SETTLEMENT_WINDOW_MS + a
 *  1-day buffer so a day gets one recompute AFTER it crosses the cutoff (→ finalized_at stamped). */
export const REHEAL_TRAILING_MS = SETTLEMENT_WINDOW_MS + 24 * 60 * 60 * 1000;
/** The scattered-backlog ceiling sits this many days back from "today" — biased LATE (≥ every fleet tz's
 *  trailing-oldest day) so the seam OVERLAPS the trailing window (harmless: trailing stamps first) instead
 *  of leaving a multi-tz gap. */
const REHEAL_CEILING_LAG_DAYS = 3;
/** Per-run cap on the scattered backlog — bounds the nightly reheal so it can never grind all history; a
 *  version-bump backlog drains oldest-first over successive nights. */
const REHEAL_MAX_DAYS_PER_RUN = 20;

/** All Area handles that have a bound battery (role='battery', metric='power') — the recompute targets. */
export async function listBatteryProvenanceHandles(): Promise<number[]> {
  const db = requirePlanetscaleDb();
  const rows = await db
    .selectDistinct({ handle: areas.legacySystemId })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .where(
      and(
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
        isNotNull(areas.legacySystemId),
      ),
    );
  return rows.map((r) => r.handle).filter((h): h is number => h != null);
}

/**
 * All Area UUIDs that have a bound battery (role='battery', metric='power') — i.e. the only Areas that
 * ever get a modern `point_readings_flow_attr_1d` leg. The legacy↔modern consistency check must be scoped
 * to these: a non-battery Area has legacy `flow_1d` but by construction NO `flow_attr_1d`, so including it
 * is a guaranteed false-positive divergence.
 */
export async function listBatteryProvenanceAreaIds(): Promise<string[]> {
  const db = requirePlanetscaleDb();
  const rows = await db
    .selectDistinct({ id: areas.id })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .where(
      and(
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    );
  return rows.map((r) => r.id);
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
async function blendIsCurrent(db: PgDb, handle: number): Promise<boolean> {
  const [bat] = await db
    .select({ sys: areaBindings.pointSystemId, pid: areaBindings.pointId })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .where(
      and(
        eq(areas.legacySystemId, handle),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    )
    .limit(1);
  const [out] = await db
    .select({ sys: areaBindings.pointSystemId, pid: areaBindings.pointId })
    .from(areaBindings)
    .innerJoin(areas, eq(areaBindings.areaId, areas.id))
    .innerJoin(systems, eq(systems.id, areaBindings.pointSystemId))
    .where(
      and(
        eq(areas.legacySystemId, handle),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "carbon-intensity"),
        eq(systems.vendorType, "helper"),
      ),
    )
    .limit(1);
  if (!bat || !out) return false; // no battery, or blend never written → recompute
  // Resolve the two integer addresses to PointIds; an unknown addr → treat as "no data" (the old
  // MAX over a nonexistent (sys,pid) returned 0 rows → null).
  const resolve = async (sys: number, pid: number): Promise<PointId | null> => {
    try {
      return await RegistryCache.pointForAddr(sys, pid);
    } catch (e) {
      if (e instanceof UnknownIdError) return null;
      throw e;
    }
  };
  const batPoint = await resolve(bat.sys, bat.pid);
  const outPoint = await resolve(out.sys, out.pid);
  const maxes = await ReadingsDao.latestAgg5mIntervalMsForPoints(
    [batPoint, outPoint].filter((p): p is PointId => p !== null),
    db,
  );
  const inMax = batPoint ? (maxes.get(batPoint) ?? null) : null;
  const outMax = outPoint ? (maxes.get(outPoint) ?? null) : null;
  if (inMax == null) return true; // no input data at all → nothing to do
  if (outMax == null) return false; // blend never written → recompute
  return outMax >= inMax;
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
    if (await blendIsCurrent(db, handle)) {
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
 * system — flow_attr_1d is the sole per-(area, day) flow matrix, so the rollup runs energy-only +
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

/**
 * Bounded, oldest-first reheal of the SCATTERED `point_readings_flow_attr_1d` backlog the contiguous
 * trailing recompute (recomputeRange over the settlement window) can't reach: days OLDER than the window
 * that are still unfinalized (`finalized_at IS NULL`) or carry a stale attribution version
 * (`version < FLOW_ATTR_VERSION`). Recomputing re-materialises the day and — being past the cutoff —
 * stamps `finalized_at`, so each day is handled once and drops out of the backlog.
 *
 * Capped per run (REHEAL_MAX_DAYS_PER_RUN) so it can never grind all history; a version-bump backlog drains
 * over successive nights. Steady-state backlog is ~empty (routine late data is WITHIN the window, handled by
 * the trailing pass). Runs LAST in the daily heal, best-effort — a hiccup here must never roll back the
 * already-committed trailing pass.
 */
export async function rehealStaleAttrDays(
  nowMs: number,
  opts: { limit?: number } = {},
): Promise<{ days: number; handles: number }> {
  const db = requirePlanetscaleDb();
  const limit = opts.limit ?? REHEAL_MAX_DAYS_PER_RUN;

  // Representative tz for the ceiling. It's late-biased, so a few hours of inter-area tz difference only
  // widens the (harmless) overlap with the trailing window — it can never open a seam gap.
  const [rep] = await db
    .select({ tz: areas.timezoneOffsetMin })
    .from(areas)
    .where(isNotNull(areas.legacySystemId))
    .limit(1);
  const ceilingDay = getTodayInTimezone(rep?.tz ?? 0)
    .subtract({ days: REHEAL_CEILING_LAG_DAYS })
    .toString();

  const rows = await db
    .selectDistinct({
      handle: areas.legacySystemId,
      tz: areas.timezoneOffsetMin,
      day: pointReadingsFlowAttr1d.day,
    })
    .from(pointReadingsFlowAttr1d)
    .innerJoin(areas, eq(areas.id, pointReadingsFlowAttr1d.areaId))
    .where(
      and(
        lt(pointReadingsFlowAttr1d.day, ceilingDay),
        or(
          isNull(pointReadingsFlowAttr1d.finalizedAt),
          lt(pointReadingsFlowAttr1d.version, FLOW_ATTR_VERSION),
        ),
        isNotNull(areas.legacySystemId),
      ),
    )
    .orderBy(asc(pointReadingsFlowAttr1d.day))
    .limit(limit);

  if (rows.length === 0) return { days: 0, handles: 0 };

  // Group the selected days by handle, then recompute each handle's [oldest, newest] span in ONE window
  // call (one 7-day warm-up + fold, vs one per day). After a version bump the oldest-N stale days are
  // contiguous per handle, so the span stays small. updateLatest + writeCheckpoints are LEFT OFF: rehealing
  // an old day must not clobber the live KV latest, and the O(today) reconcile never reads a checkpoint
  // this old.
  const byHandle = new Map<number, { tz: number; days: string[] }>();
  for (const r of rows) {
    if (r.handle == null) continue;
    const g = byHandle.get(r.handle);
    if (g) g.days.push(r.day);
    else byHandle.set(r.handle, { tz: r.tz, days: [r.day] });
  }

  for (const [handle, { tz, days }] of byHandle) {
    const sorted = [...days].sort();
    const [winStartSec] = dayToUnixRangeForAggregation(
      parseDate(sorted[0]),
      tz,
    );
    const [, winEndSec] = dayToUnixRangeForAggregation(
      parseDate(sorted[sorted.length - 1]),
      tz,
    );
    await recomputeBatteryProvenanceForWindowBestEffort(
      handle,
      winStartSec * 1000,
      winEndSec * 1000,
      { writeRollup: true, nowMs },
    );
  }
  return { days: rows.length, handles: byHandle.size };
}
