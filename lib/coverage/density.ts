/**
 * Coverage DENSITY — the read-only twin of the gap-finder (`find-gaps.ts`).
 *
 * `find-gaps.ts` answers "which days should the repair cron re-fetch?", so it is scoped to a
 * `CoverageRepairProvider` and speaks in vendor tails. This module answers the OPERATOR's question —
 * "how many 5-minute readings does each point actually hold, per day, over this window?" — for ANY
 * device, including the push vendors (`fusher`, `gusher`) that have no provider and therefore no
 * declared cadence. Both sit on the same primitive, `ReadingsDao.countAgg5mByLocalDay`.
 *
 * PURE. No DB, no clock, no IO: the route does the one grouped count and hands the map in here. That
 * is what makes the arithmetic below — which is the whole product — unit-testable.
 *
 * 🛑 **Density is a property of a POINT, not of a series.** `soc.avg`, `soc.min` and `soc.max` are
 * three series over one point and one `point_readings_agg_5m` row; counting per series would triple
 * every number. Callers select points with series globs and read the answer per point.
 */
import { parseDate, type CalendarDate } from "@internationalized/date";

/** How `expectedPerDay` was arrived at. ALWAYS reported — see {@link resolveExpectedPerDay}. */
export type ExpectedBasis = "flag" | "vendor" | "observed" | "none";

/**
 * 🛑 `"none"` is the one that matters: no cadence is declared for the vendor AND the window holds no
 * rows to infer one from, so there is NO expectation. It must never be collapsed into "0 expected,
 * therefore nothing is missing, therefore complete" — that is how a device dark for an entire
 * window gets a clean bill of health, which is the exact failure this verb exists to detect.
 */

/** A run of consecutive days in which a point held fewer rows than expected. */
export interface DensityGap {
  /** First short day of the run, local `YYYY-MM-DD`. */
  start: string;
  /** Last short day of the run, inclusive. */
  end: string;
  days: number;
  /** Total rows present across the run (0 for a clean outage). */
  present: number;
  /** Total rows the run would hold at `expectedPerDay`. */
  expected: number;
}

/**
 * A day whose mean samples-per-row falls below this fraction of the window's best day is a finding.
 *
 * Deliberately relative, like the `observed` row expectation: no vendor declares how many raw
 * readings a 5-minute row should fold, and a source that polls every 30 s rather than 60 s is not
 * wrong, only different. What IS wrong is the same point folding materially fewer on some days than
 * on its best — Kinkora's Fronius fell from 5 to 2.5 overnight on 11 August 2026 while the row count
 * stayed at 288/day.
 */
export const LOW_SAMPLE_RATIO = 0.8;

/** Mean raw readings per `agg_5m` row, per day — `device coverage --samples`. */
export interface SampleDensity {
  /** Parallel to the window's `days`; null where the point holds no rows that day. */
  meanSamples: (number | null)[];
  /** The best day's mean — the reference for {@link LOW_SAMPLE_RATIO}. Null if the point is empty. */
  bestDayMean: number | null;
  /** Days whose mean is below `LOW_SAMPLE_RATIO × bestDayMean`. Empty days are NOT listed here —
   * a missing row is a row-count gap, and `gaps` already reports it. */
  lowDays: string[];
}

/** Build a point's per-day sample density from the DAO's `localDay → mean` map. PURE. */
export function sampleDensity(
  days: string[],
  byDay: Map<string, number>,
): SampleDensity {
  const meanSamples = days.map((d) => {
    const v = byDay.get(d);
    return v === undefined || !Number.isFinite(v)
      ? null
      : Math.round(v * 100) / 100;
  });
  const present = meanSamples.filter((v): v is number => v !== null);
  const bestDayMean = present.length ? Math.max(...present) : null;
  const lowDays =
    bestDayMean === null || bestDayMean <= 0
      ? []
      : days.filter((_, i) => {
          const v = meanSamples[i];
          return v !== null && v < LOW_SAMPLE_RATIO * bestDayMean;
        });
  return { meanSamples, bestDayMean, lowDays };
}

/** One point's density over the window. `counts` is parallel to the window's `days`. */
export interface PointDensity {
  pointId: string;
  logicalPath: string | null;
  metricType: string;
  unit: string | null;
  /** Every series id that resolves to this point — the globs the caller matched on. */
  series: string[];
  counts: number[];
  total: number;
  expectedTotal: number;
  /** `total / expectedTotal * 100`, rounded to 1dp; null when nothing is expected. */
  coveragePct: number | null;
  /** First/last day with at least one row — null when the point is empty over the window. */
  firstDay: string | null;
  lastDay: string | null;
  gaps: DensityGap[];
  /** Only when the caller asked (`samples=true`) — a second grouped scan. */
  samples?: SampleDensity;
}

/**
 * The inclusive local-day calendar `start..end`. Dense by construction: every consumer below indexes
 * counts BY POSITION against this array, so a missing day must be a zero, never an absent key.
 */
export function eachLocalDay(start: string, end: string): string[] {
  const from: CalendarDate = parseDate(start);
  const to: CalendarDate = parseDate(end);
  const days: string[] = [];
  for (let d = from; d.compare(to) <= 0; ) {
    days.push(d.toString());
    const next = d.add({ days: 1 });
    // 🛑 `CalendarDate.add` SATURATES at the representable maximum: `9999-12-31 + 1 day` is
    // `9999-12-31`, so the loop condition never goes false and this spins forever. Callers validate
    // their window, but a non-advancing iterator must not be able to hang a request whoever is
    // asking — bound it here, where the assumption actually lives.
    if (next.compare(d) <= 0) break;
    d = next;
  }
  return days;
}

/**
 * How many rows a full day holds. `find-gaps.ts:89` uses exactly this rule, and it is DST-naive on
 * purpose: every local-day bucket in this system is a FIXED offset, so a day is always 1440 minutes.
 */
export function expectedPerDayFor(cadenceMinutes: number): number {
  return Math.round(1440 / cadenceMinutes);
}

/**
 * Resolve expected-rows-per-day, and say where the number came from.
 *
 * 🛑 The basis is not decoration. There is NO per-device cadence in the schema — `cadenceMinutes`
 * exists only on the three `CoverageRepairProvider`s (`lib/coverage/providers.ts`), so for a push
 * vendor there is nothing to declare and the only honest expectation is what the point actually
 * managed on its best day. Reporting `observed` as though it were `vendor` would be the same class
 * of mistake as reporting an index probe as though it were coverage.
 *
 * @param explicitCadence  `--cadence`, the operator's override; wins outright.
 * @param vendorCadence    the device's provider cadence, or null when it has no provider.
 * @param observedMax      the largest single-day count seen for this point over the window.
 */
export function resolveExpectedPerDay(
  explicitCadence: number | null,
  vendorCadence: number | null,
  observedMax: number,
): { expectedPerDay: number; basis: ExpectedBasis } {
  if (explicitCadence != null)
    return {
      expectedPerDay: expectedPerDayFor(explicitCadence),
      basis: "flag",
    };
  if (vendorCadence != null)
    return {
      expectedPerDay: expectedPerDayFor(vendorCadence),
      basis: "vendor",
    };
  // Nothing declared and nothing observed: say so. Returning `{0, "observed"}` reads downstream as
  // "0 expected per day", against which every empty day is trivially complete.
  if (observedMax <= 0) return { expectedPerDay: 0, basis: "none" };
  return { expectedPerDay: observedMax, basis: "observed" };
}

/**
 * Collapse per-day counts into runs of short days.
 *
 * A run breaks on the first complete day, so an outage with a partial day at each end (the usual
 * shape — the vendor stops mid-day and resumes mid-day) comes back as ONE gap whose `present` says
 * how much of it survived, rather than three.
 *
 * `expectedPerDay <= 0` yields no gaps: nothing is expected, so nothing can be short. That is the
 * empty-point case, and calling it a year-long gap would be noise.
 */
export function collapseGaps(
  days: string[],
  counts: number[],
  expectedPerDay: number,
): DensityGap[] {
  if (expectedPerDay <= 0) return [];
  const gaps: DensityGap[] = [];
  let open: DensityGap | null = null;
  for (let i = 0; i < days.length; i++) {
    const n = counts[i] ?? 0;
    if (n >= expectedPerDay) {
      if (open) gaps.push(open);
      open = null;
      continue;
    }
    if (!open)
      open = {
        start: days[i],
        end: days[i],
        days: 0,
        present: 0,
        expected: 0,
      };
    open.end = days[i];
    open.days += 1;
    open.present += n;
    open.expected += expectedPerDay;
  }
  if (open) gaps.push(open);
  return gaps;
}

/** Build one point's density row from the DAO's `localDay → count` map. */
export function densityForPoint(
  point: {
    pointId: string;
    logicalPath: string | null;
    metricType: string;
    unit: string | null;
    series: string[];
  },
  days: string[],
  byDay: Map<string, number>,
  expected: { expectedPerDay: number },
): PointDensity {
  const counts = days.map((d) => byDay.get(d) ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  const expectedTotal = expected.expectedPerDay * days.length;
  const firstIdx = counts.findIndex((n) => n > 0);
  const lastIdx = counts.reduce((acc, n, i) => (n > 0 ? i : acc), -1);
  return {
    ...point,
    counts,
    total,
    expectedTotal,
    coveragePct:
      expectedTotal > 0
        ? Math.round((total / expectedTotal) * 1000) / 10
        : null,
    firstDay: firstIdx === -1 ? null : days[firstIdx],
    lastDay: lastIdx === -1 ? null : days[lastIdx],
    gaps: collapseGaps(days, counts, expected.expectedPerDay),
  };
}

/**
 * The largest single-day count, considering ONLY the window's own days.
 *
 * 🛑 Scoped deliberately. The DB scan over-reaches by a day at each end (see the caller in
 * `./report.ts`), so the map carries partial buckets for the days either side of the window. Those
 * are not days the caller asked about, and letting one set the expectation would make the answer
 * depend on data outside the range being reported.
 */
export function observedMaxPerDay(
  byDay: Map<string, number>,
  days: string[],
): number {
  let max = 0;
  for (const d of days) {
    const n = byDay.get(d) ?? 0;
    if (n > max) max = n;
  }
  return max;
}

// ── Two-instrument comparison (`device coverage A --against B`) ─────────────────────────────────

/** One serving-shaped signal present on one or both sides, day by day. */
export interface DensityComparisonRow {
  /** `logicalPath/metricType` — what the two sides are matched ON. */
  key: string;
  a: PointDensity | null;
  b: PointDensity | null;
  /** Days where B holds strictly more rows than A. */
  daysOnlyB: number;
  /** Days where A holds strictly more rows than B. */
  daysOnlyA: number;
  /**
   * `Σ max(0, b − a)` over the window.
   *
   * 🛑 A LOWER BOUND on the interval-level set difference, not the difference itself. It is exact
   * only where A's intervals nest inside B's within each day; where both sides hold rows the other
   * lacks on the SAME day, the two shortfalls cancel here and the true difference is larger. Render
   * it as `≥ N` and send the caller to `device history --format csv` on the named days for the
   * exact rows — density counts rows, it never reads them.
   */
  intervalsBLacksInA: number;
  intervalsALacksInB: number;
}

/** Join two devices' densities on `(logicalPath, metricType)` and diff them day by day. */
export function compareDensity(
  a: PointDensity[],
  b: PointDensity[],
): DensityComparisonRow[] {
  // 🛑 A stemless point claims no logical identity, so it has nothing to be matched BY. Keying it on
  // a placeholder joins two unrelated points — different devices, different quantities — into one
  // "signal" and reports their difference as a discrepancy. Key it on its own id, so it can only
  // ever appear on the side it came from.
  const keyOf = (p: PointDensity) =>
    p.logicalPath === null
      ? `pt:${p.pointId}`
      : `${p.logicalPath}/${p.metricType}`;
  const byKeyA = new Map(a.map((p) => [keyOf(p), p]));
  const byKeyB = new Map(b.map((p) => [keyOf(p), p]));
  const keys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])].sort();
  return keys.map((key) => {
    const pa = byKeyA.get(key) ?? null;
    const pb = byKeyB.get(key) ?? null;
    const len = Math.max(pa?.counts.length ?? 0, pb?.counts.length ?? 0);
    let daysOnlyB = 0;
    let daysOnlyA = 0;
    let intervalsBLacksInA = 0;
    let intervalsALacksInB = 0;
    for (let i = 0; i < len; i++) {
      const na = pa?.counts[i] ?? 0;
      const nb = pb?.counts[i] ?? 0;
      if (nb > na) {
        daysOnlyB += 1;
        intervalsBLacksInA += nb - na;
      } else if (na > nb) {
        daysOnlyA += 1;
        intervalsALacksInB += na - nb;
      }
    }
    return {
      key,
      a: pa,
      b: pb,
      daysOnlyB,
      daysOnlyA,
      intervalsBLacksInA,
      intervalsALacksInB,
    };
  });
}
