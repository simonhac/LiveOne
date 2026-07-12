import { describe, it, expect } from "@jest/globals";
import {
  computeDayEnergyReadings,
  localDataTimeToUtcMs,
  enumerateDays,
  type Agg5mReading,
} from "../statistics";
import type { SigenergyEnergyInterval, SigenergyEnergyTotals } from "../types";

const TZ = 600; // AEST (minutes east of UTC)

// A tiny synthetic day: cumulative-since-local-midnight kWh counters at 5-min marks (dataTime = START).
const rows: SigenergyEnergyInterval[] = [
  mk("00:00", { gen: 0, load: 0 }),
  mk("00:05", { gen: 0.1, load: 0.2 }),
  mk("00:10", { gen: 0.3, load: 0.35 }),
  mk("00:15", { gen: 0.3, load: 0.5 }), // last sample; PV flat after 00:10
];
// Vendor daily totals (cumulative to 24:00): the tail [00:15,00:20) carries gen 0.05, load 0.10.
const totals: SigenergyEnergyTotals = {
  powerGeneration: 0.35,
  powerUse: 0.6,
  powerToGrid: 0,
  powerFromGrid: 0,
  esCharging: 0,
  esDischarging: 0,
};

function mk(
  hhmm: string,
  v: { gen: number; load: number },
): SigenergyEnergyInterval {
  return {
    dataTime: `20260711 ${hhmm}`,
    powerGeneration: v.gen,
    powerUse: v.load,
    powerToGrid: 0,
    powerFromGrid: 0,
    esCharging: 0,
    esDischarging: 0,
  };
}

const byStem = (rs: Agg5mReading[], stem: string) =>
  rs.filter((r) => r.pointMetadata.logicalPathStem === stem);
const sumWh = (rs: Agg5mReading[]) => rs.reduce((a, r) => a + r.rawValue, 0);

describe("localDataTimeToUtcMs", () => {
  it("converts local wall-clock to UTC using the tz offset", () => {
    // 2026-07-11 00:05 AEST (+600) === 2026-07-10 14:05 UTC.
    expect(localDataTimeToUtcMs("20260711 00:05", TZ)).toBe(
      Date.UTC(2026, 6, 11, 0, 5) - TZ * 60 * 1000,
    );
  });
  it("returns null for an unparseable string", () => {
    expect(localDataTimeToUtcMs("not-a-time", TZ)).toBeNull();
  });
});

describe("computeDayEnergyReadings", () => {
  it("differences consecutive counters and labels at interval_end = next dataTime", () => {
    const rd = computeDayEnergyReadings(rows, totals, TZ, false);
    const solar = byStem(rd, "source.solar");
    // 3 consecutive diffs (no tail on an incomplete day).
    expect(solar).toHaveLength(3);
    // First interval [00:00,00:05): 0.10 kWh → 100 Wh, labelled at 00:05.
    expect(solar[0].rawValue).toBe(100);
    expect(solar[0].intervalEndMs).toBe(
      localDataTimeToUtcMs("20260711 00:05", TZ),
    );
    expect(solar[1].rawValue).toBe(200); // 0.10→0.30
    expect(solar[2].rawValue).toBe(0); // PV flat 0.30→0.30
  });

  it("flickering near-zero counter (grid import) reconstructs to the small vendor total exactly — no clamp inflation", () => {
    // A self-sufficient day: powerFromGrid is ~0 and its 0.01-kWh-rounded counter FLICKERS.
    const gi = (hhmm: string, v: number): SigenergyEnergyInterval => ({
      dataTime: `20260711 ${hhmm}`,
      powerGeneration: 0,
      powerUse: 0,
      powerToGrid: 0,
      powerFromGrid: v,
      esCharging: 0,
      esDischarging: 0,
    });
    const flick = [
      gi("00:00", 0),
      gi("00:05", 0.01),
      gi("00:10", 0),
      gi("00:15", 0.01),
      gi("00:20", 0.01),
    ];
    const t: SigenergyEnergyTotals = { ...totals, powerFromGrid: 0.01 };
    const rd = computeDayEnergyReadings(flick, t, TZ, true);
    const imp = byStem(rd, "bidi.grid.import");
    // Signed diffs telescope + tail reconciles → exactly 10 Wh (NOT the clamped-inflated 20 Wh).
    expect(sumWh(imp)).toBe(10);
    // signed diffs are genuinely used (a −0.01 flicker interval is emitted, not clamped to 0).
    expect(imp.some((r) => r.rawValue < 0)).toBe(true);
  });

  it("an INCOMPLETE day gets no tail; sum equals the last counter (not the daily total)", () => {
    const rd = computeDayEnergyReadings(rows, totals, TZ, false);
    expect(sumWh(byStem(rd, "source.solar"))).toBe(300); // = counter[last] 0.30 kWh
    expect(sumWh(byStem(rd, "load"))).toBe(500); // = counter[last] 0.50 kWh
  });

  it("a COMPLETED day reconstructs EXACTLY to the vendor daily total (residual tail)", () => {
    const rd = computeDayEnergyReadings(rows, totals, TZ, true);
    const solar = byStem(rd, "source.solar");
    const load = byStem(rd, "load");
    // 3 diffs + 1 tail interval.
    expect(solar).toHaveLength(4);
    expect(sumWh(solar)).toBe(Math.round(totals.powerGeneration! * 1000)); // 350
    expect(sumWh(load)).toBe(Math.round(totals.powerUse! * 1000)); // 600
    // The tail lands one interval past the last sample.
    const tail = solar[solar.length - 1];
    expect(tail.intervalEndMs).toBe(
      localDataTimeToUtcMs("20260711 00:15", TZ)! + 5 * 60 * 1000,
    );
    expect(tail.rawValue).toBe(50); // 0.35 total − 0.30 accumulated
  });

  it("telescopes: no drift accumulates over the day (sum of diffs = last counter, exact)", () => {
    // Even with 0.01-rounded counters, the intermediate diffs sum to counter[last] exactly.
    const rd = computeDayEnergyReadings(rows, totals, TZ, false);
    expect(sumWh(byStem(rd, "source.solar"))).toBe(300);
  });

  it("returns nothing for an empty day", () => {
    expect(computeDayEnergyReadings([], totals, TZ, true)).toEqual([]);
  });
});

describe("enumerateDays", () => {
  it("is inclusive of both ends", () => {
    const days = enumerateDays("20260706", "20260712");
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("20260706");
    expect(days[6]).toBe("20260712");
  });
  it("handles a single day", () => {
    expect(enumerateDays("20260712", "20260712")).toEqual(["20260712"]);
  });
});
