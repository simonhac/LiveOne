/**
 * Battery-provenance orchestration — the cron-facing layer (mirrors lib/run-tracking/recompute.ts and
 * lib/hws/recompute.ts). Enumerates the battery-bearing Areas and drives the prod driver
 * (recomputeBatteryProvenanceForWindow*) over a trailing window (minutely) or an explicit range (daily
 * heal / backfill), chunked. Best-effort throughout so a fold hiccup never breaks the aggregation it trails.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, areas } from "@/lib/db/planetscale/schema";
import { recomputeBatteryProvenanceForWindowBestEffort } from "@/lib/db/planetscale/battery-provenance-pg";
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

/** Minutely: keep the last `trailingMs` fresh for every battery Area + refresh the KV latest blend. */
export async function reconcileTrailingWindow(
  nowMs: number,
  trailingMs: number = DEFAULT_TRAILING_MS,
  config?: ProvenanceConfig,
): Promise<{ handles: number }> {
  const handles = await listBatteryProvenanceHandles();
  for (const handle of handles) {
    await recomputeBatteryProvenanceForWindowBestEffort(
      handle,
      nowMs - trailingMs,
      nowMs,
      { updateLatest: true, config },
    );
  }
  return { handles: handles.length };
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
        config,
      });
      onChunk?.({ handle, chunkStartMs: cs, chunkEndMs: ce });
    }
  }
}
