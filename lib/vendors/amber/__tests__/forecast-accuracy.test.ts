/**
 * Amber forecast-accuracy scoring — pure logic: truth selection, change-only alignment, metrics.
 * The DB legs (which rows to fetch) are exercised by running the script against dev, not here.
 */
import { describe, expect, it } from "@jest/globals";
import {
  cutoffMsFor,
  parseLeads,
  forecastInForceAt,
  pairForecastsWithActuals,
  persistenceSkill,
  quantile,
  scoreableTargets,
  selectTruth,
  summarisePairs,
  truthDisagreements,
  type ForecastObservation,
  type ScoredPair,
  type SettledActual,
} from "../forecast-accuracy";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A round target interval to anchor fixtures on: 2026-08-15T04:00:00Z (14:00 AEST). */
const T = Date.parse("2026-08-15T04:00:00Z");

function obs(
  intervalEndMs: number,
  observedAtMs: number,
  perKwh: number | null,
  band?: [number, number, number],
): ForecastObservation {
  return {
    intervalEndMs,
    observedAtMs,
    perKwh,
    advLow: band?.[0] ?? null,
    advPredicted: band?.[1] ?? null,
    advHigh: band?.[2] ?? null,
  };
}

const truthOf = (
  entries: [number, number, string][],
): Map<number, SettledActual> =>
  selectTruth(
    entries.map(([intervalEndMs, value, quality]) => ({
      intervalEndMs,
      value,
      quality,
    })),
  );

describe("parseLeads", () => {
  it("takes a comma list", () => {
    expect(parseLeads("1,2,6,12")).toEqual([1, 2, 6, 12]);
  });

  it("expands an inclusive range", () => {
    expect(parseLeads("1-12")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("mixes ranges and singles, deduping and sorting", () => {
    expect(parseLeads("6,1-3,2,12")).toEqual([1, 2, 3, 6, 12]);
  });

  it("accepts a fractional lead as an explicit entry", () => {
    expect(parseLeads("0.5,1")).toEqual([0.5, 1]);
  });

  it("tolerates whitespace and trailing separators", () => {
    expect(parseLeads(" 1 , 2 ,")).toEqual([1, 2]);
  });

  /** A silently-wrong lead set would score the wrong cutoffs and look entirely plausible. */
  it("rejects garbage rather than dropping it", () => {
    expect(() => parseLeads("1,abc")).toThrow(/bad lead/);
    expect(() => parseLeads("0")).toThrow(/bad lead/);
    expect(() => parseLeads("-3")).toThrow(/bad lead/);
    expect(() => parseLeads("12-1")).toThrow(/bad lead range/);
  });
});

describe("cutoffMsFor", () => {
  it("anchors the lead to the interval END", () => {
    expect(cutoffMsFor(T, 6)).toBe(T - 6 * HOUR);
    expect(cutoffMsFor(T, 0.5)).toBe(T - 30 * 60_000);
  });
});

describe("selectTruth", () => {
  it("keeps only settled readings", () => {
    const truth = truthOf([
      [T, 22, "f"],
      [T + HOUR, 25, "e"],
      [T + 2 * HOUR, 30, "a"],
    ]);
    expect([...truth.keys()]).toEqual([T + 2 * HOUR]);
  });

  it("prefers billable over actual regardless of arrival order", () => {
    expect(
      truthOf([
        [T, 20, "a"],
        [T, 21, "b"],
      ]).get(T)!.value,
    ).toBe(21);
    expect(
      truthOf([
        [T, 21, "b"],
        [T, 20, "a"],
      ]).get(T)!.value,
    ).toBe(21);
  });
});

describe("truthDisagreements", () => {
  it("counts only intervals that carry both an actual and a billable", () => {
    const readings: SettledActual[] = [
      { intervalEndMs: T, value: 20, quality: "a" },
      { intervalEndMs: T, value: 21, quality: "b" },
      { intervalEndMs: T + HOUR, value: 30, quality: "a" },
      { intervalEndMs: T + HOUR, value: 30, quality: "b" },
      { intervalEndMs: T + 2 * HOUR, value: 40, quality: "b" },
    ];
    expect(truthDisagreements(readings)).toEqual({ compared: 2, differing: 1 });
  });
});

describe("forecastInForceAt — change-only alignment", () => {
  const revisions = [
    obs(T, T - 20 * HOUR, 30),
    obs(T, T - 7 * HOUR, 25),
    obs(T, T - 1 * HOUR, 22),
  ];

  it("picks the last revision at or before the cutoff, however old", () => {
    // Nothing was published between 20h and 7h out: the 20h-old row is still in force at 12h.
    expect(forecastInForceAt(revisions, cutoffMsFor(T, 12))?.perKwh).toBe(30);
    expect(forecastInForceAt(revisions, cutoffMsFor(T, 6))?.perKwh).toBe(25);
    expect(forecastInForceAt(revisions, cutoffMsFor(T, 1))?.perKwh).toBe(22);
  });

  it("is undefined before the first revision — never the nearest LATER one", () => {
    expect(forecastInForceAt(revisions, cutoffMsFor(T, 24))).toBeUndefined();
  });

  it("does not care about input order", () => {
    const shuffled = [revisions[2], revisions[0], revisions[1]];
    expect(forecastInForceAt(shuffled, cutoffMsFor(T, 6))?.perKwh).toBe(25);
  });
});

describe("pairForecastsWithActuals", () => {
  const truth = truthOf([
    [T, 24, "b"],
    [T + 30 * 60_000, 26, "b"],
  ]);

  it("pairs on interval_end and signs the error forecast − actual", () => {
    const pairs = pairForecastsWithActuals(
      [obs(T, T - 3 * HOUR, 27)],
      truth,
      2,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].forecast).toBe(27);
    expect(pairs[0].actual).toBe(24);
    expect(pairs[0].error).toBe(3); // forecast HIGH ⇒ positive
  });

  it("reports staleness from the cutoff, not from the interval", () => {
    const pairs = pairForecastsWithActuals(
      [obs(T, T - 3 * HOUR, 27)],
      truth,
      2,
    );
    expect(pairs[0].stalenessMin).toBe(60); // observed 3h out, cutoff at 2h out
  });

  it("drops a target with no revision at or before the cutoff", () => {
    // Captured only 1h out, so it cannot be scored at 6h.
    expect(
      pairForecastsWithActuals([obs(T, T - HOUR, 27)], truth, 6),
    ).toHaveLength(0);
  });

  it("drops a target with no settled truth", () => {
    const pairs = pairForecastsWithActuals(
      [obs(T + 99 * HOUR, T, 27)],
      truth,
      1,
    );
    expect(pairs).toHaveLength(0);
  });

  it("drops rows carrying no price (the synthetic site rows)", () => {
    expect(
      pairForecastsWithActuals([obs(T, T - 3 * HOUR, null)], truth, 2),
    ).toHaveLength(0);
  });

  it("excludes pairs staler than --max-staleness-min when asked", () => {
    const revisions = [obs(T, T - 3 * HOUR, 27)];
    expect(
      pairForecastsWithActuals(revisions, truth, 2, { maxStalenessMin: 30 }),
    ).toHaveLength(0);
    expect(
      pairForecastsWithActuals(revisions, truth, 2, { maxStalenessMin: 90 }),
    ).toHaveLength(1);
  });

  it("scores the band only when one was published", () => {
    const inside = pairForecastsWithActuals(
      [obs(T, T - 3 * HOUR, 27, [20, 25, 30])],
      truth,
      2,
    );
    expect(inside[0].inBand).toBe(true);
    const outside = pairForecastsWithActuals(
      [obs(T, T - 3 * HOUR, 27, [25, 27, 30])],
      truth,
      2,
    );
    expect(outside[0].inBand).toBe(false); // actual 24 sits below low 25
    const none = pairForecastsWithActuals([obs(T, T - 3 * HOUR, 27)], truth, 2);
    expect(none[0].inBand).toBeNull();
  });

  it("handles a feed-in band whose low sits numerically ABOVE its high", () => {
    // Amber's low/high are cheap/expensive; on feedIn a payment is negative, so low > high.
    const negTruth = truthOf([[T, -9.5, "b"]]);
    const inside = pairForecastsWithActuals(
      [obs(T, T - 3 * HOUR, -9.7, [-6.35, -8.13, -9.99])],
      negTruth,
      2,
    );
    expect(inside[0].inBand).toBe(true);
    const outside = pairForecastsWithActuals(
      [obs(T, T - 3 * HOUR, -9.7, [-6.35, -5.0, -4.0])],
      negTruth,
      2,
    );
    expect(outside[0].inBand).toBe(false);
  });

  it("keeps targets independent and returns them in interval order", () => {
    const pairs = pairForecastsWithActuals(
      [obs(T + 30 * 60_000, T - 3 * HOUR, 40), obs(T, T - 3 * HOUR, 27)],
      truth,
      2,
    );
    expect(pairs.map((p) => p.intervalEndMs)).toEqual([T, T + 30 * 60_000]);
    expect(pairs.map((p) => p.error)).toEqual([3, 14]);
  });
});

describe("scoreableTargets", () => {
  it("counts distinct captured intervals that also settled", () => {
    const truth = truthOf([
      [T, 24, "b"],
      [T + HOUR, 26, "b"],
    ]);
    expect(scoreableTargets([T, T, T + HOUR, T + 5 * HOUR], truth)).toBe(2);
  });
});

describe("quantile", () => {
  it("interpolates like percentile_cont", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 10);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe("summarisePairs", () => {
  const pair = (
    error: number,
    staleness = 0,
    inBand: boolean | null = null,
  ): ScoredPair => ({
    intervalEndMs: T + error * HOUR,
    observedAtMs: T,
    stalenessMin: staleness,
    forecast: 20 + error,
    actual: 20,
    error,
    advPredicted: null,
    inBand,
  });

  it("computes the metric set on a fixture with a known answer", () => {
    // errors +1, −3, +2, −2 ⇒ |e| 1,2,2,3; bias −0.5; RMSE √(18/4)
    const s = summarisePairs([pair(1), pair(-3), pair(2), pair(-2)], 8);
    expect(s.paired).toBe(4);
    expect(s.targets).toBe(8);
    expect(s.coverage).toBe(0.5);
    expect(s.mae).toBe(2);
    expect(s.bias).toBe(-0.5);
    expect(s.rmse).toBeCloseTo(Math.sqrt(4.5), 10);
    expect(s.p50AbsError).toBe(2);
    expect(s.maxAbsError).toBe(3);
  });

  it("reports the SPREAD of the errors, not the precision of the mean", () => {
    // errors +1, −3, +2, −2 ⇒ |e| 1,2,2,3 (mean 2, population var 0.5) and signed mean −0.5
    // (population var 4.25). The chart's ±1 s.d. band is drawn from these.
    const s = summarisePairs([pair(1), pair(-3), pair(2), pair(-2)], 4);
    expect(s.sdAbsError).toBeCloseTo(Math.sqrt(0.5), 10);
    expect(s.sdError).toBeCloseTo(Math.sqrt(4.25), 10);
  });

  it("reports the standard ERROR of the mean separately from the spread", () => {
    // The bias band is drawn from this, and it must shrink with n while the spread does not.
    const four = summarisePairs([pair(1), pair(-3), pair(2), pair(-2)], 4);
    expect(four.seError).toBeCloseTo(four.sdError / Math.sqrt(4), 10);

    const sixteen = summarisePairs(
      [pair(1), pair(-3), pair(2), pair(-2)].flatMap((p) => [p, p, p, p]),
      16,
    );
    expect(sixteen.sdError).toBeCloseTo(four.sdError, 10); // spread unchanged
    expect(sixteen.seError).toBeCloseTo(four.seError / 2, 10); // precision doubles
  });

  it("keeps the identity rmse² = bias² + sdError²", () => {
    const s = summarisePairs([pair(1), pair(-3), pair(2), pair(-2)], 4);
    expect(s.rmse ** 2).toBeCloseTo(s.bias ** 2 + s.sdError ** 2, 10);
  });

  it("reports zero spread for identical errors", () => {
    const s = summarisePairs([pair(2), pair(2), pair(2)], 3);
    expect(s.sdAbsError).toBe(0);
    expect(s.sdError).toBe(0);
  });

  it("scores band coverage over only the pairs that had a band", () => {
    const s = summarisePairs(
      [pair(1, 0, true), pair(2, 0, false), pair(3, 0, null)],
      3,
    );
    expect(s.bandCoverage).toBe(0.5);
  });

  it("returns NaN metrics but a real coverage when nothing paired", () => {
    const s = summarisePairs([], 10);
    expect(s.paired).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.mae).toBeNaN();
    expect(s.sdAbsError).toBeNaN();
    expect(s.sdError).toBeNaN();
    expect(s.seError).toBeNaN();
    expect(s.bandCoverage).toBeNaN();
  });

  it("surfaces staleness percentiles — a capture gap looks like a quiet forecast otherwise", () => {
    const s = summarisePairs([pair(1, 2), pair(1, 4), pair(1, 30)], 3);
    expect(s.p50StalenessMin).toBe(4);
    expect(s.maxStalenessMin).toBe(30);
  });
});

describe("persistenceSkill", () => {
  const pairAt = (intervalEndMs: number, error: number): ScoredPair => ({
    intervalEndMs,
    observedAtMs: intervalEndMs - HOUR,
    stalenessMin: 0,
    forecast: 20 + error,
    actual: 20,
    error,
    advPredicted: null,
    inBand: null,
  });

  it("compares both MAEs over the same subset", () => {
    const truth = truthOf([
      [T, 20, "b"],
      [T - DAY, 24, "b"], // persistence would have said 24 ⇒ |24−20| = 4
      [T + HOUR, 20, "b"], // no yesterday ⇒ excluded from BOTH sides
    ]);
    const skill = persistenceSkill([pairAt(T, 1), pairAt(T + HOUR, 9)], truth)!;
    expect(skill.n).toBe(1);
    expect(skill.maeForecast).toBe(1);
    expect(skill.maePersistence).toBe(4);
    expect(skill.skill).toBeCloseTo(0.75, 10);
  });

  it("is null when no interval has a same-half-hour-yesterday actual", () => {
    expect(
      persistenceSkill([pairAt(T, 1)], truthOf([[T, 20, "b"]])),
    ).toBeNull();
  });
});
