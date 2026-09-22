import { describe, it, expect } from "@jest/globals";
import {
  sampleDensity,
  LOW_SAMPLE_RATIO,
  collapseGaps,
  compareDensity,
  densityForPoint,
  eachLocalDay,
  expectedPerDayFor,
  observedMaxPerDay,
  resolveExpectedPerDay,
  type PointDensity,
} from "../density";

const POINT = {
  pointId: "pt_a",
  logicalPath: "bidi.battery",
  metricType: "soc",
  unit: "%",
  series: ["8/bidi.battery/soc.avg"],
};

describe("eachLocalDay", () => {
  it("is inclusive at both ends", () => {
    expect(eachLocalDay("2026-01-30", "2026-02-02")).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("returns the single day when start === end", () => {
    expect(eachLocalDay("2026-03-05", "2026-03-05")).toEqual(["2026-03-05"]);
  });

  /**
   * 🛑 `CalendarDate.add` SATURATES at the representable maximum — `9999-12-31 + 1 day` is
   * `9999-12-31` — so a naive `for (…; d.compare(to) <= 0; d = d.add({days:1}))` never terminates.
   * The route validates its window, but a non-advancing iterator must not be able to hang a
   * request whoever is asking.
   */
  it("terminates at the maximum representable date instead of spinning forever", () => {
    expect(eachLocalDay("9999-12-31", "9999-12-31")).toEqual(["9999-12-31"]);
  });
});

describe("expectedPerDayFor", () => {
  // The three cadences that actually exist, per lib/coverage/providers.ts.
  it("matches the gap-finder's 1440/cadence rule", () => {
    expect(expectedPerDayFor(5)).toBe(288);
    expect(expectedPerDayFor(30)).toBe(48);
  });
});

describe("resolveExpectedPerDay", () => {
  it("prefers the explicit cadence over everything", () => {
    expect(resolveExpectedPerDay(5, 30, 12)).toEqual({
      expectedPerDay: 288,
      basis: "flag",
    });
  });

  it("falls back to the vendor cadence", () => {
    expect(resolveExpectedPerDay(null, 30, 288)).toEqual({
      expectedPerDay: 48,
      basis: "vendor",
    });
  });

  /**
   * The push-vendor case, and the reason `basis` is on the wire at all. `fusher` declares no
   * cadence, so the only honest expectation is the point's own best day — and it must be LABELLED
   * `observed`, never presented as a vendor fact.
   */
  it("falls back to the observed best day, and says so", () => {
    expect(resolveExpectedPerDay(null, null, 288)).toEqual({
      expectedPerDay: 288,
      basis: "observed",
    });
  });

  /**
   * 🛑 The failure this exists to prevent. No declared cadence AND nothing observed is NOT
   * "0 expected per day" — against which every empty day is trivially complete, so a device dark
   * for the whole window would report a clean bill of health. That device is exactly the case the
   * verb was built to surface.
   */
  it("reports NO basis when nothing is declared and nothing was observed", () => {
    expect(resolveExpectedPerDay(null, null, 0)).toEqual({
      expectedPerDay: 0,
      basis: "none",
    });
  });
});

describe("collapseGaps", () => {
  const days = eachLocalDay("2026-01-01", "2026-01-08");

  it("collapses consecutive short days into ONE run", () => {
    // full, full, [0,0,0], full, [144], full
    const counts = [288, 288, 0, 0, 0, 288, 144, 288];
    expect(collapseGaps(days, counts, 288)).toEqual([
      {
        start: "2026-01-03",
        end: "2026-01-05",
        days: 3,
        present: 0,
        expected: 864,
      },
      {
        start: "2026-01-07",
        end: "2026-01-07",
        days: 1,
        present: 144,
        expected: 288,
      },
    ]);
  });

  /**
   * The real outage shape: the vendor stops mid-day and resumes mid-day, so the run has a partial
   * day at each end. That is ONE gap whose `present` says what survived — reporting three would
   * make every outage in the fleet read as three.
   */
  it("keeps a partial day at each end inside the same run", () => {
    const counts = [288, 42, 0, 0, 0, 190, 288, 288];
    expect(collapseGaps(days, counts, 288)).toEqual([
      {
        start: "2026-01-02",
        end: "2026-01-06",
        days: 5,
        present: 232,
        expected: 1440,
      },
    ]);
  });

  it("reports nothing when every day is complete", () => {
    expect(
      collapseGaps(
        days,
        days.map(() => 288),
        288,
      ),
    ).toEqual([]);
  });

  /**
   * An empty point expects nothing, so nothing can be short. Without this, a point with no rows at
   * all would report the whole window as one enormous gap — noise that buries the real findings.
   */
  it("reports nothing when nothing is expected", () => {
    expect(
      collapseGaps(
        days,
        days.map(() => 0),
        0,
      ),
    ).toEqual([]);
  });

  it("treats a day above expected as complete, not as a finding", () => {
    expect(collapseGaps(["2026-01-01"], [289], 288)).toEqual([]);
  });
});

describe("densityForPoint", () => {
  const days = eachLocalDay("2026-01-01", "2026-01-04");

  it("indexes counts BY POSITION, so an absent day is a zero", () => {
    const d = densityForPoint(
      POINT,
      days,
      // 01-02 and 01-03 are simply absent from the DAO's map.
      new Map([
        ["2026-01-01", 288],
        ["2026-01-04", 144],
      ]),
      { expectedPerDay: 288 },
    );
    expect(d.counts).toEqual([288, 0, 0, 144]);
    expect(d.total).toBe(432);
    expect(d.expectedTotal).toBe(1152);
    expect(d.coveragePct).toBe(37.5);
    // First/last DAY WITH DATA — not the window edges.
    expect(d.firstDay).toBe("2026-01-01");
    expect(d.lastDay).toBe("2026-01-04");
  });

  it("reports null extents and a null percentage for an empty point", () => {
    const d = densityForPoint(POINT, days, new Map(), { expectedPerDay: 0 });
    expect(d.firstDay).toBeNull();
    expect(d.lastDay).toBeNull();
    expect(d.coveragePct).toBeNull();
    expect(d.gaps).toEqual([]);
  });
});

describe("observedMaxPerDay", () => {
  it("is the largest single day, not the last or the mean", () => {
    expect(
      observedMaxPerDay(
        new Map([
          ["a", 12],
          ["b", 288],
          ["c", 41],
        ]),
        ["a", "b", "c"],
      ),
    ).toBe(288);
  });

  it("is 0 for a point with no rows", () => {
    expect(observedMaxPerDay(new Map(), ["a"])).toBe(0);
  });

  /**
   * The scan over-reaches by a day at each end (see `report.ts`), so the map carries partial
   * buckets outside the window. Letting one of those set the expectation would make the answer
   * depend on data the caller did not ask about.
   */
  it("ignores buckets outside the window", () => {
    expect(
      observedMaxPerDay(
        new Map([
          ["2026-01-01", 999],
          ["2026-01-02", 48],
          ["2026-01-04", 999],
        ]),
        ["2026-01-02", "2026-01-03"],
      ),
    ).toBe(48);
  });
});

/**
 * 🛑 The interval-END convention, which is where the original off-by-one lived.
 *
 * `localDayExpr` buckets on `interval_end - 1 second`, so a row belongs to local day D when its
 * `interval_end` is in (midnight(D), midnight(D) + 1 day] — the LAST interval of day D carries
 * D+1's midnight as its stamp. A scan bounded `>= midnight(start) AND < midnight(end) + 1 day`
 * therefore drops that final row, and a complete day counts 287 of 288.
 */
describe("the scan window (regression: the last day lost one interval)", () => {
  const OFFSET = 600; // UTC+10, the fleet's fixed offset
  const DAY_MS = 86_400_000;
  const midnight = (d: string) =>
    Date.parse(`${d}T00:00:00Z`) - OFFSET * 60_000;
  const localDay = (ms: number) =>
    new Date(ms + OFFSET * 60_000 - 1000).toISOString().slice(0, 10);

  it("the tight upper bound excludes a row that belongs to the final day", () => {
    const day = "2026-01-02";
    const lastStamp = midnight(day) + DAY_MS;
    // It really is the final day's row...
    expect(localDay(lastStamp)).toBe(day);
    // ...and `< midnight(end) + 1 day` excludes it. This is the bug, pinned.
    expect(lastStamp < midnight(day) + DAY_MS).toBe(false);
    // The shipped bounds over-reach, so they include it.
    expect(lastStamp < midnight(day) + 2 * DAY_MS).toBe(true);
  });

  it("over-reaching captures all 288 intervals of a complete day", () => {
    const day = "2026-01-02";
    const from = midnight(day) - DAY_MS;
    const to = midnight(day) + 2 * DAY_MS;
    let onDay = 0;
    for (let i = 1; i <= 288; i++) {
      const t = midnight(day) + i * 300_000;
      if (localDay(t) === day && t >= from && t < to) onDay++;
    }
    expect(onDay).toBe(288);
  });
});

describe("compareDensity", () => {
  const mk = (
    logicalPath: string,
    metricType: string,
    counts: number[],
    pointId = `pt_${logicalPath}${metricType}`,
  ): PointDensity => ({
    pointId,
    logicalPath,
    metricType,
    unit: null,
    series: [],
    counts,
    total: counts.reduce((a, b) => a + b, 0),
    expectedTotal: counts.length * 288,
    coveragePct: null,
    firstDay: null,
    lastDay: null,
    gaps: [],
  });

  it("joins on (logical path, metric), not on point id", () => {
    const rows = compareDensity(
      [mk("bidi.battery", "soc", [288, 0], "pt_fronius")],
      [mk("bidi.battery", "soc", [288, 288], "pt_mondo")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("bidi.battery/soc");
    expect(rows[0].a?.pointId).not.toBe(rows[0].b?.pointId);
  });

  it("counts the shortfall in each direction separately", () => {
    // day 1: A leads by 100. day 2: B leads by 288.
    const rows = compareDensity(
      [mk("bidi.battery", "soc", [100, 0])],
      [mk("bidi.battery", "soc", [0, 288])],
    );
    expect(rows[0]).toMatchObject({
      daysOnlyA: 1,
      daysOnlyB: 1,
      intervalsALacksInB: 100,
      intervalsBLacksInA: 288,
    });
  });

  /**
   * 🛑 The documented under-count. Within ONE day the two shortfalls cancel, so the reported number
   * is a LOWER bound on the true interval-level set difference. This test pins that behaviour so
   * nobody "fixes" it into a number that claims more than it measured — the rendering says `≥` for
   * exactly this reason.
   */
  it("is a LOWER bound: same-day shortfalls in both directions cancel", () => {
    const rows = compareDensity(
      [mk("bidi.battery", "soc", [100])],
      [mk("bidi.battery", "soc", [200])],
    );
    // B truly has up to 200 intervals A lacks; day granularity can only see the net 100.
    expect(rows[0].intervalsBLacksInA).toBe(100);
    expect(rows[0].intervalsALacksInB).toBe(0);
  });

  /**
   * 🛑 A stemless point has no logical identity to be matched BY. `getPath()`\'s fallback for one is
   * `{index}/{metric}`, which is per-DEVICE — so keying on it joined two unrelated points on
   * different devices into a single "signal" and reported their difference as a discrepancy.
   */
  it("never joins two stemless points across devices", () => {
    const rows = compareDensity(
      [mk(null as unknown as string, "power", [288], "pt_a")],
      [mk(null as unknown as string, "power", [0], "pt_b")],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.a === null) !== (r.b === null))).toBe(true);
  });

  it("keeps a signal present on only one side", () => {
    const rows = compareDensity(
      [mk("bidi.battery", "soc", [288])],
      [mk("source.solar", "power", [288])],
    );
    expect(rows.map((r) => [r.key, r.a !== null, r.b !== null])).toEqual([
      ["bidi.battery/soc", true, false],
      ["source.solar/power", false, true],
    ]);
  });
});

describe("sampleDensity", () => {
  const days = ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"];

  it("flags a day folding materially fewer readings than the best day (the Aug 2026 halving)", () => {
    const out = sampleDensity(
      days,
      new Map([
        ["2026-08-09", 5],
        ["2026-08-10", 4.98],
        ["2026-08-11", 2.5],
        ["2026-08-12", 2.51],
      ]),
    );
    expect(out.bestDayMean).toBe(5);
    expect(out.meanSamples).toEqual([5, 4.98, 2.5, 2.51]);
    expect(out.lowDays).toEqual(["2026-08-11", "2026-08-12"]);
  });

  it("leaves an empty day to the row-count gaps rather than calling it low", () => {
    const out = sampleDensity(days, new Map([["2026-08-10", 5]]));
    expect(out.meanSamples).toEqual([null, 5, null, null]);
    expect(out.lowDays).toEqual([]);
  });

  it("is exactly at the threshold → not low", () => {
    const out = sampleDensity(
      ["a", "b"],
      new Map([
        ["a", 10],
        ["b", 10 * LOW_SAMPLE_RATIO],
      ]),
    );
    expect(out.lowDays).toEqual([]);
  });

  it("reports nothing for an empty point", () => {
    expect(sampleDensity(days, new Map())).toEqual({
      meanSamples: [null, null, null, null],
      bestDayMean: null,
      lowDays: [],
    });
  });
});
