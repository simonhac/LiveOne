/**
 * Battery-provenance orchestration — the cron-facing layer (mirrors lib/run-tracking/recompute.ts and
 * lib/hws/recompute.ts). Enumerates the battery-bearing Areas and drives the prod driver
 * (recomputeBatteryProvenanceForWindow*) over a trailing window (minutely) or an explicit range (daily
 * heal / backfill), chunked. Best-effort throughout so a fold hiccup never breaks the aggregation it trails.
 */
import { and, eq, isNotNull, max } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  systems,
  pointReadingsAgg5m,
} from "@/lib/db/planetscale/schema";
import {
  recomputeBatteryProvenanceForWindowBestEffort,
  reconcileFromCheckpointBestEffort,
} from "@/lib/db/planetscale/battery-provenance-pg";
import { learnAllForHandle } from "@/lib/db/planetscale/battery-provenance-daily-pg";
import type { ProvenanceConfig } from "./types";

/** Minutely trailing window. 12h (> HWS/run-tracking's 6h) because Amber revises hours later and devices
 * can go stale; the recompute extends this back by its own WARMUP_MS to anchor the fold at a reset. */
export const DEFAULT_TRAILING_MS = 12 * 60 * 60 * 1000;
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LIVEONE_BIRTHDATE_MS = Date.parse("2025-08-16T00:00:00Z");

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
  const maxEnd = async (sys: number, pid: number): Promise<number | null> => {
    const [row] = await db
      .select({ m: max(pointReadingsAgg5m.intervalEnd) })
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, sys),
          eq(pointReadingsAgg5m.pointId, pid),
        ),
      );
    return row?.m != null
      ? new Date(row.m as string | number | Date).getTime()
      : null;
  };
  const inMax = await maxEnd(bat.sys, bat.pid);
  const outMax = await maxEnd(out.sys, out.pid);
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

/** Daily heal / backfill: recompute an explicit range for every battery Area, in bounded chunks. */
export async function recomputeRange(
  startMs: number,
  endMs: number,
  config?: ProvenanceConfig,
  onChunk?: (info: RangeChunkInfo) => void,
): Promise<void> {
  const handles = await listBatteryProvenanceHandles();
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
