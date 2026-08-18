/**
 * Amber forecast-accuracy scoring — the pure half.
 *
 * `amber_forecast_history` records what Amber PUBLISHED for a target interval over the ~24-36h
 * before it happened; `point_readings_agg_5m` records what the interval actually COST once settled.
 * This module turns those two into error statistics per lead time. The DB legs (which rows to
 * fetch, from where) live in `scripts/amber/forecast-accuracy.ts`; everything here is pure so the
 * arithmetic and — more importantly — the alignment rules are unit-testable.
 *
 * Two alignment rules carry all the risk:
 *
 * 1. **Lead anchors to the interval END.** The forecast "6h out" for the interval ending 14:00 is
 *    the last one published at or before 08:00. (The interval covers 13:30-14:00, so this is 6h
 *    before it finishes, 5.5h before it starts.) `cutoffMsFor` is the only place that convention
 *    exists.
 *
 * 2. **Capture is change-only**, so the forecast in force at the cutoff is the last STORED row at
 *    or before it — which may have been observed hours earlier, meaning only "Amber has not moved
 *    it since". Picking "the row observed nearest the cutoff" instead would silently score a
 *    different, later forecast. `stalenessMin` exposes how old the row was, so a capture outage
 *    (which looks identical to a quiet forecast) can be spotted rather than assumed away.
 *
 * A target with no stored row at or before the cutoff was not yet in Amber's horizon (or capture
 * was not yet running): it is counted against COVERAGE and excluded from the error stats. It is
 * never treated as a zero-error forecast.
 */

import { isSettledQuality } from "@/lib/data-quality";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One stored forecast revision for a target interval (the columns scoring needs). */
export interface ForecastObservation {
  intervalEndMs: number;
  observedAtMs: number;
  perKwh: number | null;
  advLow: number | null;
  advPredicted: number | null;
  advHigh: number | null;
}

/** The settled truth for a target interval, read from the 5m aggregate. */
export interface SettledActual {
  intervalEndMs: number;
  value: number;
  /** Raw `data_quality` marker — `b` (billable, final) beats `a` (actual). */
  quality: string;
}

/** A forecast matched to the truth for the same interval, at one lead. */
export interface ScoredPair {
  intervalEndMs: number;
  observedAtMs: number;
  /** How stale the in-force forecast was at the cutoff, in minutes. */
  stalenessMin: number;
  forecast: number;
  actual: number;
  /** Signed: positive = Amber forecast HIGH. */
  error: number;
  advPredicted: number | null;
  /** Did the actual land inside the published advancedPrice band? `null` when no band. */
  inBand: boolean | null;
}

export interface AccuracySummary {
  /** Scoreable targets: settled truth AND at least one captured forecast revision. */
  targets: number;
  /** Of those, how many had a forecast in force at the cutoff. */
  paired: number;
  /** paired / targets, 0..1. NaN when targets === 0. */
  coverage: number;
  mae: number;
  /** Mean error. Positive = Amber forecasts HIGH on average. */
  bias: number;
  rmse: number;
  p50AbsError: number;
  p90AbsError: number;
  maxAbsError: number;
  /** Fraction of pairs whose actual fell inside [advLow, advHigh]; NaN if no band was published. */
  bandCoverage: number;
  /** MAE of `advPredicted` over the pairs that carried one; NaN if none did. */
  advPredictedMae: number;
  p50StalenessMin: number;
  p90StalenessMin: number;
  maxStalenessMin: number;
}

/** Forecast MAE vs a same-interval-yesterday persistence baseline, over the pairs where both exist. */
export interface SkillScore {
  n: number;
  maeForecast: number;
  maePersistence: number;
  /** 1 − MAE_forecast / MAE_persistence. >0 = better than persistence; NaN if the baseline is 0. */
  skill: number;
}

/**
 * The instant a forecast must have been published by, to count as being "leadHours out".
 * Anchored to the interval END (see the module doc-comment).
 */
export function cutoffMsFor(intervalEndMs: number, leadHours: number): number {
  return intervalEndMs - leadHours * HOUR_MS;
}

/**
 * Keep only settled readings, preferring `b` (billable, final) over `a` (actual) for the same
 * interval. Amber restates a price when it settles, so scoring against `a` when a `b` exists
 * measures the forecast against a number Amber itself has since revised.
 */
export function selectTruth(
  readings: readonly SettledActual[],
): Map<number, SettledActual> {
  const truth = new Map<number, SettledActual>();
  for (const r of readings) {
    if (!isSettledQuality(r.quality)) continue;
    const existing = truth.get(r.intervalEndMs);
    if (!existing || (existing.quality !== "b" && r.quality === "b")) {
      truth.set(r.intervalEndMs, r);
    }
  }
  return truth;
}

/** How often `a` and `b` disagree for the same interval — a sanity check on the truth source. */
export function truthDisagreements(
  readings: readonly SettledActual[],
  tolerance = 0.001,
): { compared: number; differing: number } {
  const byInterval = new Map<number, Map<string, number>>();
  for (const r of readings) {
    if (!isSettledQuality(r.quality)) continue;
    let m = byInterval.get(r.intervalEndMs);
    if (!m) byInterval.set(r.intervalEndMs, (m = new Map()));
    m.set(r.quality, r.value);
  }
  let compared = 0;
  let differing = 0;
  for (const m of byInterval.values()) {
    const a = m.get("a");
    const b = m.get("b");
    if (a === undefined || b === undefined) continue;
    compared++;
    if (Math.abs(a - b) > tolerance) differing++;
  }
  return { compared, differing };
}

/** The forecast in force at `cutoffMs`: the last stored revision at or before it. */
export function forecastInForceAt(
  revisions: readonly ForecastObservation[],
  cutoffMs: number,
): ForecastObservation | undefined {
  let best: ForecastObservation | undefined;
  for (const r of revisions) {
    if (r.observedAtMs > cutoffMs) continue;
    if (!best || r.observedAtMs > best.observedAtMs) best = r;
  }
  return best;
}

/**
 * How many target intervals are scoreable at all: distinct intervals that were captured AND have
 * settled truth. This is the denominator for coverage — NOT "every interval in the window", which
 * would charge Amber for intervals we simply had not started logging yet.
 */
export function scoreableTargets(
  capturedIntervalEndMs: Iterable<number>,
  truth: ReadonlyMap<number, SettledActual>,
): number {
  const seen = new Set<number>();
  for (const ms of capturedIntervalEndMs) if (truth.has(ms)) seen.add(ms);
  return seen.size;
}

/**
 * Pair every scoreable target with the forecast in force `leadHours` before its end.
 *
 * `revisions` may hold every stored revision for the window, or one row per interval already
 * reduced by a `DISTINCT ON … WHERE observed_at <= cutoff` query — grouping and the at-or-before
 * pick happen here either way. Targets without settled truth are not scoreable and are dropped.
 */
export function pairForecastsWithActuals(
  revisions: readonly ForecastObservation[],
  truth: ReadonlyMap<number, SettledActual>,
  leadHours: number,
  options: { maxStalenessMin?: number } = {},
): ScoredPair[] {
  const byInterval = new Map<number, ForecastObservation[]>();
  for (const r of revisions) {
    if (!truth.has(r.intervalEndMs)) continue;
    const list = byInterval.get(r.intervalEndMs);
    if (list) list.push(r);
    else byInterval.set(r.intervalEndMs, [r]);
  }

  const pairs: ScoredPair[] = [];
  for (const [intervalEndMs, list] of byInterval) {
    const cutoffMs = cutoffMsFor(intervalEndMs, leadHours);
    const inForce = forecastInForceAt(list, cutoffMs);
    if (!inForce || inForce.perKwh === null) continue;

    const stalenessMin = (cutoffMs - inForce.observedAtMs) / 60_000;
    if (
      options.maxStalenessMin !== undefined &&
      stalenessMin > options.maxStalenessMin
    ) {
      continue;
    }

    const actual = truth.get(intervalEndMs)!.value;
    // Amber's advancedPrice `low`/`high` are cheap/expensive, not numerically ordered: on the
    // feedIn channel a price is NEGATIVE when you are being paid, so `low` (-6.35) sits ABOVE
    // `high` (-9.99). Taking the interval literally scored feed-in band coverage as a flat 0%.
    const hasBand = inForce.advLow !== null && inForce.advHigh !== null;
    const bandLo = hasBand ? Math.min(inForce.advLow!, inForce.advHigh!) : NaN;
    const bandHi = hasBand ? Math.max(inForce.advLow!, inForce.advHigh!) : NaN;
    pairs.push({
      intervalEndMs,
      observedAtMs: inForce.observedAtMs,
      stalenessMin,
      forecast: inForce.perKwh,
      actual,
      error: inForce.perKwh - actual,
      advPredicted: inForce.advPredicted,
      inBand: hasBand ? actual >= bandLo && actual <= bandHi : null,
    });
  }

  pairs.sort((a, b) => a.intervalEndMs - b.intervalEndMs);
  return pairs;
}

/** Linear-interpolated quantile over an ascending array — matches PG's `percentile_cont`. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarisePairs(
  pairs: readonly ScoredPair[],
  targets: number,
): AccuracySummary {
  const n = pairs.length;
  const empty = {
    targets,
    paired: n,
    coverage: targets === 0 ? NaN : n / targets,
  };
  if (n === 0) {
    return {
      ...empty,
      mae: NaN,
      bias: NaN,
      rmse: NaN,
      p50AbsError: NaN,
      p90AbsError: NaN,
      maxAbsError: NaN,
      bandCoverage: NaN,
      advPredictedMae: NaN,
      p50StalenessMin: NaN,
      p90StalenessMin: NaN,
      maxStalenessMin: NaN,
    };
  }

  const absErrors = pairs.map((p) => Math.abs(p.error)).sort((a, b) => a - b);
  const staleness = pairs.map((p) => p.stalenessMin).sort((a, b) => a - b);
  const sumAbs = absErrors.reduce((s, v) => s + v, 0);
  const sumSigned = pairs.reduce((s, p) => s + p.error, 0);
  const sumSquares = pairs.reduce((s, p) => s + p.error * p.error, 0);

  const banded = pairs.filter((p) => p.inBand !== null);
  const withAdv = pairs.filter((p) => p.advPredicted !== null);

  return {
    ...empty,
    mae: sumAbs / n,
    bias: sumSigned / n,
    rmse: Math.sqrt(sumSquares / n),
    p50AbsError: quantile(absErrors, 0.5),
    p90AbsError: quantile(absErrors, 0.9),
    maxAbsError: absErrors[absErrors.length - 1],
    bandCoverage:
      banded.length === 0
        ? NaN
        : banded.filter((p) => p.inBand).length / banded.length,
    advPredictedMae:
      withAdv.length === 0
        ? NaN
        : withAdv.reduce(
            (s, p) => s + Math.abs(p.advPredicted! - p.actual),
            0,
          ) / withAdv.length,
    p50StalenessMin: quantile(staleness, 0.5),
    p90StalenessMin: quantile(staleness, 0.9),
    maxStalenessMin: staleness[staleness.length - 1],
  };
}

/**
 * Score the forecast against "yesterday's settled price for this same half-hour".
 *
 * Without a baseline, "MAE 1.6 c/kWh" has no scale — it could be excellent or useless depending on
 * how volatile prices were. Both MAEs are computed over the SAME subset (pairs whose 24h-earlier
 * interval also settled), or the comparison is rigged.
 */
export function persistenceSkill(
  pairs: readonly ScoredPair[],
  truth: ReadonlyMap<number, SettledActual>,
): SkillScore | null {
  let n = 0;
  let sumForecast = 0;
  let sumPersistence = 0;
  for (const p of pairs) {
    const yesterday = truth.get(p.intervalEndMs - DAY_MS);
    if (!yesterday) continue;
    n++;
    sumForecast += Math.abs(p.error);
    sumPersistence += Math.abs(yesterday.value - p.actual);
  }
  if (n === 0) return null;
  const maeForecast = sumForecast / n;
  const maePersistence = sumPersistence / n;
  return {
    n,
    maeForecast,
    maePersistence,
    skill: maePersistence === 0 ? NaN : 1 - maeForecast / maePersistence,
  };
}
