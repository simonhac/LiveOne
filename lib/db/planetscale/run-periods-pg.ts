/**
 * Postgres-side run-period recompute (run-tracking feature).
 *
 * Turns a tracker's bounded raw signal readings into coalesced run periods and persists them in
 * `device_run_periods`. The pure state machine lives in `lib/run-tracking/detect.ts`; this is the
 * thin DB shell — read bounded raw → detect → batched energy → write — mirroring the split in
 * `aggregate-points-pg.ts`.
 *
 * Idempotency under shifting boundaries: a run's start_time is data-derived and can move (late
 * data can split/merge runs or move a start earlier), so a plain upsert-on-start would orphan
 * rows. Instead each pass does a **bounded delete-and-reinsert** of an *anchored* window, under a
 * per-(system) advisory lock: find the run straddling the window's left edge, read raw from a
 * `delayOff` margin before it, rebuild from scratch, and delete exactly the [anchor, winEnd] span
 * we reinsert. So whatever the samples now imply is what lands, with no orphans/dupes, and periods
 * outside the window (later, for a historical backfill) are untouched.
 */
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { planetscaleDb } from "./index";
import { deviceRunPeriods, pointReadings } from "./schema";
import { detectRunPeriods, type Sample } from "@/lib/run-tracking/detect";
import { assignEnergyToPeriods } from "@/lib/run-tracking/energy";
import type { PointRef, ResolvedTracker } from "@/lib/run-tracking/resolve";

type PgDb = NonNullable<typeof planetscaleDb>;
type PgExecutor = PgDb | Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/** Fixed namespace for the per-system run-period recompute advisory lock. ascii "RUNP". */
const RUN_PERIODS_LOCK_NS = 0x52554e50;

export interface RecomputeResult {
  deleted: number;
  inserted: number;
  open: boolean;
}

/** Bounded read of one point's raw readings over [fromMs, toMs], ascending. */
async function readPointSeries(
  db: PgExecutor,
  ref: PointRef,
  fromMs: number,
  toMs: number,
): Promise<Sample[]> {
  const rows = await db
    .select({
      measurementTime: pointReadings.measurementTime,
      value: pointReadings.value,
    })
    .from(pointReadings)
    .where(
      and(
        eq(pointReadings.systemId, ref.systemId),
        eq(pointReadings.pointId, ref.pointId),
        gte(pointReadings.measurementTime, new Date(fromMs)),
        lte(pointReadings.measurementTime, new Date(toMs)),
      ),
    )
    .orderBy(asc(pointReadings.measurementTime));
  return rows.map((r) => ({
    tMs: r.measurementTime.getTime(),
    value: r.value,
  }));
}

/**
 * Recompute one tracker's run periods over [winStartMs, winEndMs], "as of" nowMs. Bounded,
 * idempotent, and safe to re-run. Returns how many rows were deleted/inserted and whether the
 * window ends with an open (running-now) period.
 */
export async function recomputeRunPeriodsForWindow(
  db: PgDb,
  tracker: ResolvedTracker,
  winStartMs: number,
  winEndMs: number,
  nowMs: number,
): Promise<RecomputeResult> {
  return db.transaction(async (tx) => {
    // Serialize recomputes for THIS system so a concurrent run can't interleave delete/insert.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${RUN_PERIODS_LOCK_NS}::int4, ${tracker.systemId}::int4)`,
    );

    // Anchor: the run starting before the window that overlaps it — rebuild from its start so a
    // straddling run isn't truncated. Otherwise anchor at the window start.
    const [straddler] = await tx
      .select({
        startTime: deviceRunPeriods.startTime,
        endTime: deviceRunPeriods.endTime,
      })
      .from(deviceRunPeriods)
      .where(
        and(
          eq(deviceRunPeriods.systemId, tracker.systemId),
          eq(deviceRunPeriods.role, tracker.role),
          lt(deviceRunPeriods.startTime, new Date(winStartMs)),
        ),
      )
      .orderBy(desc(deviceRunPeriods.startTime))
      .limit(1);

    let anchorMs = winStartMs;
    if (straddler) {
      const sEnd = straddler.endTime ? straddler.endTime.getTime() : null;
      if (sEnd === null || sEnd >= winStartMs) {
        anchorMs = straddler.startTime.getTime();
      }
    }

    const readStartMs = anchorMs - tracker.detect.delayOffMs; // margin for the straddler's lead-in

    const samples = await readPointSeries(
      tx,
      tracker.signalRef,
      readStartMs,
      winEndMs,
    );

    const periods = detectRunPeriods(samples, {
      lowerW: tracker.detect.lowerW,
      upperW: tracker.detect.upperW,
      hysteresisW: tracker.detect.hysteresisW,
      delayOnMs: tracker.detect.delayOnMs,
      delayOffMs: tracker.detect.delayOffMs,
      nowMs,
      boundaryMode: tracker.detect.boundaryMode,
    }).filter((p) => p.startMs >= anchorMs && p.startMs <= winEndMs);

    // Batched energy (one read for the whole window) — replaces the legacy per-event N+1.
    let energies: (number | null)[] = periods.map(() => null);
    if (tracker.energyRef && periods.length > 0) {
      const readings = await readPointSeries(
        tx,
        tracker.energyRef,
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
      .delete(deviceRunPeriods)
      .where(
        and(
          eq(deviceRunPeriods.systemId, tracker.systemId),
          eq(deviceRunPeriods.role, tracker.role),
          gte(deviceRunPeriods.startTime, new Date(anchorMs)),
          lte(deviceRunPeriods.startTime, new Date(winEndMs)),
        ),
      )
      .returning({ startTime: deviceRunPeriods.startTime });

    let inserted = 0;
    if (periods.length > 0) {
      const rows = periods.map((p, i) => ({
        systemId: tracker.systemId,
        role: tracker.role,
        startTime: new Date(p.startMs),
        endTime: p.endMs != null ? new Date(p.endMs) : null,
        signalSystemId: tracker.signalRef.systemId,
        signalPointId: tracker.signalRef.pointId,
        trackerId: tracker.id,
        durationSeconds:
          p.endMs != null ? Math.round((p.endMs - p.startMs) / 1000) : null,
        energyKwh: energies[i],
        maxPowerW: p.maxW,
        minPowerW: p.minW,
        avgPowerW: p.avgW,
        sampleCount: p.sampleCount,
        detectorVersion: tracker.detectorVersion,
      }));
      await tx.insert(deviceRunPeriods).values(rows);
      inserted = rows.length;
    }

    return {
      deleted: deletedRows.length,
      inserted,
      open: periods.some((p) => p.endMs === null),
    };
  });
}
