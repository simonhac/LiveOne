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
 * `delayOff` margin either side of it, rebuild from scratch, and delete exactly the [anchor, winEnd]
 * span we reinsert. So whatever the samples now imply is what lands, with no orphans/dupes, and
 * periods outside the window (later, for a historical backfill) are untouched.
 *
 * The margin is on BOTH edges and the reasons differ: the leading one lets a straddling run be
 * rebuilt from its true start, the trailing one lets the detector tell a run that ENDED at the
 * window's edge from one that was merely cut off by it. See `readEndMs` — a chunked historical
 * recompute dropped a run's whole continuation across every chunk boundary without it.
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
  allocateCounterToWindows,
  energyFromAllocation,
  provenanceFromAllocation,
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
      // TOLERANT BY delayOff, and that tolerance is the repair half of the chunk-boundary fix
      // below. A stored run that ends just before this window began may have ended because the
      // SIGNAL stopped, or because the pass that wrote it could not see past its own read edge —
      // the row cannot tell you which. Anything closer than delayOff to the window start could
      // still have been continued by this window's first sample, so re-anchor on it and let the
      // detector decide from the samples. When it really did end there the rebuild is idempotent
      // and costs one slightly earlier read; when it didn't, this is what stitches the run back
      // together. Rows already truncated on prod heal through exactly this branch, without needing
      // the whole range re-run.
      if (sEnd === null || sEnd >= winStartMs - det.detect.delayOffMs) {
        anchorMs = straddler.startTime.getTime();
      }
    }

    const readStartMs = anchorMs - det.detect.delayOffMs; // margin for the straddler's lead-in
    // ...and its MIRROR, which is not symmetric decoration: without it a chunked historical
    // recompute LOSES DATA. `detectRunPeriods` closes the final run at its last on-sample whenever
    // `nowMs − lastOn > delayOff`, so a read that stops dead at `winEndMs` makes a run that is still
    // going look like a run that ended there. The next chunk then re-detects the continuation from
    // its own lead-in, that period starts BEFORE the chunk's anchor, and the `p.startMs >= anchorMs`
    // filter below discards it — the charging after the boundary is dropped entirely. Measured on
    // prod 2026-08-02: a 10-month re-price of the Kinkora EV detector left four runs ending within
    // five minutes of a 14-day chunk boundary, and those four days were the top four for "metered
    // energy attributed to no run" — 21.8 kWh between them.
    //
    // Reading delayOff past the window is exactly enough to tell the two apart: if the signal is
    // still on, the run is stored with an end PAST `winEndMs`, which is what makes the next chunk's
    // straddler test fire and rebuild the run whole from its true start. (A run continuing beyond
    // this margin is still cut here — but it is cut past the boundary, so the stitch happens.)
    //
    // 🛑 The filter and the DELETE window stay on `winEndMs`. Widening the delete is the one change
    // that looks equivalent and isn't: the bounded delete is what stops a chunk nuking the periods a
    // later chunk already wrote.
    const readEndMs = winEndMs + det.detect.delayOffMs;

    const samples = await readPointSeries(
      tx,
      det.signalPoint,
      readStartMs,
      readEndMs,
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
      // `readEndMs`, not `winEndMs`: a period that continues past the window is stored with its true
      // end, so the counter has to be read that far or its energy is silently understated.
      const readings = await readPointSeries(
        tx,
        det.energyPoint,
        readStartMs,
        readEndMs,
      );
      const windows = periods.map((p) => ({
        startMs: p.startMs,
        endMs: p.endMs,
      }));
      // What this device's energy costs/emits, resolved ONCE for the whole batch — never per run.
      //
      // 🛑 LAZY AND RUN-WINDOWED, both deliberately. The generator leg is one small config read, but
      // the load leg (`ev`) reads the engine's persisted per-interval blend and reassembles the
      // load-path average from it, which is a real query. Resolving it HERE rather than at the top of
      // the function means:
      //  - a pass that detected no runs does no work at all (the common case for the minutely cron,
      //    whose 6h trailing window is mostly idle), and
      //  - it spans only the runs being priced, not the whole recompute window.
      // `winStartMs`/`winEndMs` would cover hours nobody is pricing; the runs' own span is the
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

      // ONE allocation, two readings of it. `samples` is the SIGNAL series the detector already used
      // to place these boundaries (no extra query — the same array `detectRunPeriods` consumed), so
      // the allocator divides a boundary-straddling counter step by how hard the device was actually
      // working either side of the edge, and models the switch AT the edge the detector chose.
      const alloc = allocateCounterToWindows(windows, readings, nowMs, samples);
      energies = energyFromAllocation(alloc);
      if (intensity) provenance = provenanceFromAllocation(alloc, intensity);
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
