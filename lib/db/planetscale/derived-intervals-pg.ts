/**
 * Postgres-side derived-interval recompute (config-v4 derivations, `output='intervals'`).
 *
 * Turns a run detector's bounded raw signal readings into coalesced run periods and persists them
 * in `derived_intervals`. The pure state machine lives in `lib/run-tracking/detect.ts`; this is the
 * thin DB shell — read bounded raw → detect → batched energy → write — mirroring the split in
 * `aggregate-points-pg.ts`.
 *
 * Idempotency under shifting boundaries: a run's start_time is data-derived and can move (late
 * data can split/merge runs or move a start earlier), so a plain upsert-on-start would orphan
 * rows. Instead each pass does a **bounded delete-and-reinsert** of an *anchored* window, under a
 * per-derivation advisory lock: find the run straddling the window's left edge, read raw from a
 * `delayOff` margin before it, rebuild from scratch, and delete exactly the [anchor, winEnd] span
 * we reinsert. So whatever the samples now imply is what lands, with no orphans/dupes, and periods
 * outside the window (later, for a historical backfill) are untouched.
 *
 * Was `run-periods-pg.ts`, keyed by `(system_id, role)`. The key is now the single
 * `derivation_id` — 1:1 with the old pair via `derivations_area_role_unique` — so the source
 * points arrive pre-resolved as `PointId`s and no `RegistryCache.pointForAddr` hop is needed.
 */
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { planetscaleDb } from "./index";
import { derivedIntervals } from "./schema";
import { ReadingsDao } from "@/lib/readings";
import type { PointId } from "@/lib/ids";
import { detectRunPeriods, type Sample } from "@/lib/run-tracking/detect";
import { assignEnergyToPeriods } from "@/lib/run-tracking/energy";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";

type PgDb = NonNullable<typeof planetscaleDb>;
type PgExecutor = PgDb | Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/** Fixed namespace for the derived-interval recompute advisory lock. ascii "RUNP". */
const RUN_PERIODS_LOCK_NS = 0x52554e50;

export interface RecomputeResult {
  deleted: number;
  inserted: number;
  open: boolean;
}

/** Bounded read of one point's raw readings over [fromMs, toMs], ascending. */
async function readPointSeries(
  db: PgExecutor,
  id: PointId | null,
  fromMs: number,
  toMs: number,
): Promise<Sample[]> {
  if (id === null) return [];
  const series = await ReadingsDao.readRaw([id], { fromMs, toMs }, db);
  return series.get(id)!.map((r) => ({
    tMs: r.measurementTimeMs,
    value: r.value,
  }));
}

/**
 * Recompute one detector's intervals over [winStartMs, winEndMs], "as of" nowMs. Bounded,
 * idempotent, and safe to re-run. Returns how many rows were deleted/inserted and whether the
 * window ends with an open (running-now) period.
 */
export async function recomputeIntervalsForWindow(
  db: PgDb,
  det: ResolvedRunDetector,
  winStartMs: number,
  winEndMs: number,
  nowMs: number,
): Promise<RecomputeResult> {
  return db.transaction(async (tx) => {
    // Serialize recomputes for THIS derivation so a concurrent run can't interleave delete/insert.
    // `hashtext` folds the uuid into the int4 the advisory-lock API takes; a collision would only
    // over-serialize two unrelated derivations, which is harmless.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${RUN_PERIODS_LOCK_NS}::int4, hashtext(${det.id})::int4)`,
    );

    // Anchor: the run starting before the window that overlaps it — rebuild from its start so a
    // straddling run isn't truncated. Otherwise anchor at the window start.
    const [straddler] = await tx
      .select({
        startTime: derivedIntervals.startTime,
        endTime: derivedIntervals.endTime,
      })
      .from(derivedIntervals)
      .where(
        and(
          eq(derivedIntervals.derivationId, det.id),
          lt(derivedIntervals.startTime, new Date(winStartMs)),
        ),
      )
      .orderBy(desc(derivedIntervals.startTime))
      .limit(1);

    let anchorMs = winStartMs;
    if (straddler) {
      const sEnd = straddler.endTime ? straddler.endTime.getTime() : null;
      if (sEnd === null || sEnd >= winStartMs) {
        anchorMs = straddler.startTime.getTime();
      }
    }

    const readStartMs = anchorMs - det.detect.delayOffMs; // margin for the straddler's lead-in

    const samples = await readPointSeries(
      tx,
      det.signalPoint,
      readStartMs,
      winEndMs,
    );

    const periods = detectRunPeriods(samples, {
      lowerW: det.detect.lowerW,
      upperW: det.detect.upperW,
      hysteresisW: det.detect.hysteresisW,
      delayOnMs: det.detect.delayOnMs,
      delayOffMs: det.detect.delayOffMs,
      nowMs,
      boundaryMode: det.detect.boundaryMode,
    }).filter((p) => p.startMs >= anchorMs && p.startMs <= winEndMs);

    // Batched energy (one read for the whole window) — replaces the legacy per-event N+1.
    let energies: (number | null)[] = periods.map(() => null);
    if (det.energyPoint && periods.length > 0) {
      const readings = await readPointSeries(
        tx,
        det.energyPoint,
        readStartMs,
        winEndMs,
      );
      energies = assignEnergyToPeriods(
        periods.map((p) => ({ startMs: p.startMs, endMs: p.endMs })),
        readings,
        nowMs,
      );
    }

    // Delete exactly the span we rebuild: [anchor, winEnd]. Bounded so later periods (relative to
    // a historical window) are never nuked.
    const deletedRows = await tx
      .delete(derivedIntervals)
      .where(
        and(
          eq(derivedIntervals.derivationId, det.id),
          gte(derivedIntervals.startTime, new Date(anchorMs)),
          lte(derivedIntervals.startTime, new Date(winEndMs)),
        ),
      )
      .returning({ startTime: derivedIntervals.startTime });

    let inserted = 0;
    if (periods.length > 0) {
      const rows = periods.map((p, i) => ({
        derivationId: det.id,
        startTime: new Date(p.startMs),
        endTime: p.endMs != null ? new Date(p.endMs) : null,
        durationSeconds:
          p.endMs != null ? Math.round((p.endMs - p.startMs) / 1000) : null,
        energyKwh: energies[i],
        maxPowerW: p.maxW,
        minPowerW: p.minW,
        avgPowerW: p.avgW,
        sampleCount: p.sampleCount,
        detectorVersion: det.detectorVersion,
      }));
      await tx.insert(derivedIntervals).values(rows);
      inserted = rows.length;
    }

    return {
      deleted: deletedRows.length,
      inserted,
      open: periods.some((p) => p.endMs === null),
    };
  });
}
