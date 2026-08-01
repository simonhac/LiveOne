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
 *
 * Signal statistics carry their unit (migration 0055). `detectRunPeriods` returns max/min/avg of
 * the SIGNAL SERIES — whatever it measures — so each row is stamped with `det.signalUnit`, the raw
 * unit of the point those samples came from. The fields are still spelled `maxW/minW/avgW` in
 * `DetectedPeriod` because the detector's own vocabulary is thresholds-in-W by history; the
 * `W` there means "the threshold-comparable magnitude", not Watts.
 */
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { planetscaleDb } from "./index";
import { derivedIntervals } from "./schema";
import { ReadingsDao } from "@/lib/readings";
import type { PointId } from "@/lib/ids";
import { detectRunPeriods, type Sample } from "@/lib/run-tracking/detect";
import {
  assignEnergyToPeriods,
  assignProvenanceToPeriods,
  NO_PROVENANCE,
  type PeriodProvenance,
} from "@/lib/run-tracking/energy";
import { resolveIntensitySeries } from "@/lib/run-tracking/intensity";
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
    let provenance: PeriodProvenance[] = periods.map(() => NO_PROVENANCE);
    if (det.energyPoint && periods.length > 0) {
      const readings = await readPointSeries(
        tx,
        det.energyPoint,
        readStartMs,
        winEndMs,
      );
      const windows = periods.map((p) => ({
        startMs: p.startMs,
        endMs: p.endMs,
      }));
      energies = assignEnergyToPeriods(windows, readings, nowMs);

      // What this device's energy costs/emits, resolved ONCE for the whole batch — never per run.
      //
      // 🛑 LAZY AND RUN-WINDOWED, both deliberately. The generator leg is one small config read, but
      // the load leg (`ev`) reassembles the battery-provenance fold, which is materially more
      // expensive. Resolving it HERE rather than at the top of the function means:
      //  - a pass that detected no runs does no work at all (the common case for the minutely cron,
      //    whose 6h trailing window is mostly idle), and
      //  - the fold spans only the runs being priced, not the whole recompute window.
      // `winStartMs`/`winEndMs` would fold hours nobody is pricing; the runs' own span is the
      // smallest window that can answer the question.
      //
      // Skipped entirely without an energy point (see the enclosing `if`): provenance is integrated
      // over that counter's slices, so there would be nothing to apply a series to.
      // Read on the POOL, not `tx`: this is a read-only side query over tables this transaction
      // neither reads for correctness nor writes (bindings, agg_5m, learned params), and the load
      // leg's fold uses the pool internally regardless. It cannot deadlock against us — we hold an
      // advisory lock and, at this point, no row locks at all.
      const spanStartMs = Math.min(...windows.map((w) => w.startMs));
      const spanEndMs = Math.max(...windows.map((w) => w.endMs ?? nowMs));
      const intensity = await resolveIntensitySeries(db, det, {
        startMs: spanStartMs,
        endMs: spanEndMs,
      });

      // Cost/emissions/renewable ride the SAME readings — the energy-weighted integral over the
      // counter's own slices, so a run's provenance and its energy can never disagree.
      if (intensity) {
        provenance = assignProvenanceToPeriods(
          windows,
          readings,
          intensity,
          nowMs,
        );
      }
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
      // A statistic is stored WITH ITS UNIT or not at all. `det.signalUnit` is the signal point's
      // raw `points.unit` as of right now, which is precisely what makes the stored number readable
      // later: a re-point (Selectronic grid W → DSE engine rpm) changes the unit of every subsequent
      // row and leaves the earlier ones correctly labelled, instead of silently changing what the
      // same three columns mean. See `derived_intervals_signal_unit_check`.
      //
      // Unlabellable ⇒ omitted, never guessed. A missing `points` row is a broken binding; dropping
      // three statistics degrades the runs table, whereas writing a number whose unit is unknown is
      // the exact defect this stage exists to remove (and would violate the CHECK, failing the whole
      // recompute over a config gap).
      const labelled = det.signalUnit !== null;
      const rows = periods.map((p, i) => ({
        derivationId: det.id,
        startTime: new Date(p.startMs),
        endTime: p.endMs != null ? new Date(p.endMs) : null,
        durationSeconds:
          p.endMs != null ? Math.round((p.endMs - p.startMs) / 1000) : null,
        energyKwh: energies[i],
        costC: provenance[i].costC,
        emissionsG: provenance[i].emissionsG,
        renewableKwh: provenance[i].renewableKwh,
        maxSignal: labelled ? p.maxW : null,
        minSignal: labelled ? p.minW : null,
        avgSignal: labelled ? p.avgW : null,
        signalUnit: det.signalUnit,
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
