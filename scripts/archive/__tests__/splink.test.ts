/**
 * The Daylesford reconstruction: SP LINK's 15-minute log → LiveOne's 5-minute series.
 *
 * 🛑 The property that must not break is that the RESAMPLE PRESERVES EACH WINDOW'S MEAN. The
 * smoothing is a rendering choice; the interval's energy is a fact, and `recomputeAgg1dForDay`
 * sums 5-minute deltas into the day. A smoother that quietly changed the mean would show up as a
 * prettier chart and a wrong daily total.
 */
import { describe, it, expect } from "@jest/globals";
import {
  AVERAGED,
  FIFTEEN_MIN_MS,
  FIVE_MIN_MS,
  quantities,
  resampleAverages,
  resampleInstant,
  type SplinkRecord,
} from "../splink";

const T = Date.parse("2026-09-11T00:00:00Z");
const rec = (over: Partial<SplinkRecord> = {}): SplinkRecord => ({
  tMs: T,
  loadAcKw: 2.8,
  acCoupledKw: 0.5,
  shunt1A: -4,
  dcVoltageV: 50,
  acInputKw: 0,
  socPct: 64,
  ...over,
});

describe("quantities", () => {
  it("converts kW to W and derives the DC-coupled solar from shunt1 x bus voltage", () => {
    const q = quantities(rec());
    expect(q["load/power"]).toBe(2800);
    expect(q["source.solar.remote/power"]).toBe(500);
    // -(-4 A) x 50 V = 200 W. shunt1 is sign-inverted at this site; shunt2 is identically zero.
    expect(q["source.solar.local/power"]).toBe(200);
    expect(q["source.solar/power"]).toBe(700);
  });

  it("derives battery power as load - solar_total, not from an inverter column", () => {
    // 🛑 `inverter_ac_power_average_kw` correlates at -0.970 with slope -1.302 — wrong sign and an
    // unexplained 1.3x, because it is AC throughput and the 1.3 was solar's missing DC half.
    // LiveOne's own battery series IS this identity (r = 0.99292 against its own columns).
    expect(quantities(rec())["bidi.battery/power"]).toBe(2100);
  });

  it("passes SoC through untouched — it is already a percentage", () => {
    expect(quantities(rec())["bidi.battery/soc"]).toBe(64);
  });

  it("yields null, never zero, when an input the identity needs is missing", () => {
    // A missing shunt reading is not 0 A. Substituting zero would make the battery absorb the
    // whole of the DC-coupled solar and look like it was charging.
    const q = quantities(rec({ shunt1A: null }));
    expect(q["source.solar.local/power"]).toBeNull();
    expect(q["source.solar/power"]).toBeNull();
    expect(q["bidi.battery/power"]).toBeNull();
    // The ones that do not depend on it survive.
    expect(q["load/power"]).toBe(2800);
  });
});

describe("resampleAverages", () => {
  const win = (n: number, value: number | null) => ({
    tMs: T + n * FIFTEEN_MIN_MS,
    value,
  });

  it("puts a record's three buckets BEFORE its stamp", () => {
    // The averages cover (T-15, T] — the trailing window fits at r = 0.9825 against 0.9648 leading.
    const out = resampleAverages([win(0, 100)]);
    expect(out.map((o) => o.startMs)).toEqual([
      T - FIFTEEN_MIN_MS,
      T - FIFTEEN_MIN_MS + FIVE_MIN_MS,
      T - FIVE_MIN_MS,
    ]);
  });

  it("preserves each window's mean exactly", () => {
    const out = resampleAverages([win(0, 100), win(1, 400), win(2, 200)]);
    for (const [i, expected] of [100, 400, 200].entries()) {
      const triple = out.slice(i * 3, i * 3 + 3).map((o) => o.value);
      expect(triple.reduce((a, b) => a + b, 0) / 3).toBeCloseTo(expected, 9);
    }
  });

  it("leans towards the neighbours rather than stepping", () => {
    const out = resampleAverages([win(0, 100), win(1, 400), win(2, 200)]);
    const middle = out.slice(3, 6).map((o) => o.value);
    // The 400 window sits between 100 and 200, so it rises from below and falls towards the last.
    expect(middle[0]).toBeLessThan(middle[1]);
    expect(middle[2]).toBeLessThan(middle[1]);
    expect(middle.some((v) => v !== 400)).toBe(true);
  });

  it("holds flat rather than extrapolating off the end of a run", () => {
    // 🛑 One window, nothing either side. Fitting a slope through a single point is invention.
    const out = resampleAverages([win(0, 100)]);
    expect(out.map((o) => o.value)).toEqual([100, 100, 100]);
    expect(out.every((o) => o.held)).toBe(true);
  });

  it("does not bridge a window the archive is missing", () => {
    // win(2) is absent — the eight isolated missing records the splink manifest declares. The
    // surviving windows lean only on the neighbour they actually have.
    const out = resampleAverages([win(0, 100), win(3, 400)]);
    expect(out).toHaveLength(6);
    expect(out.every((o) => o.held)).toBe(true);
  });

  it("emits nothing for a window whose value is null", () => {
    expect(resampleAverages([win(0, null)])).toEqual([]);
  });

  it("leaves an all-zero window at zero", () => {
    // The off-grid case: ac_input is identically 0, and a rescale would divide by its mean.
    const out = resampleAverages([win(0, 0), win(1, 0)]);
    expect(out.every((o) => o.value === 0)).toBe(true);
  });
});

describe("resampleInstant", () => {
  const stamp = (n: number, value: number | null) => ({
    tMs: T + n * FIFTEEN_MIN_MS,
    value,
  });

  it("lands a stamp on its own bucket and interpolates the two between", () => {
    // SP LINK's SoC at T equals LiveOne's soc.last for the bucket STARTING at T — measured at
    // r = 1.00000, median absolute difference 0.011 %.
    const out = resampleInstant([stamp(0, 60), stamp(1, 63)]);
    expect(out.slice(0, 3).map((o) => [o.startMs - T, o.value])).toEqual([
      [0, 60],
      [FIVE_MIN_MS, 61],
      [2 * FIVE_MIN_MS, 62],
    ]);
  });

  it("refuses to bridge a span longer than one step", () => {
    // 🛑 Bounded, like derive-power.ts's MAX_INTERP_INTERVALS. A straight line across a longer hole
    // is invention rather than recovery.
    const out = resampleInstant([stamp(0, 60), stamp(4, 80)]);
    expect(out.map((o) => o.value)).toEqual([60, 80]);
  });

  it("emits the stamp but no bridge when the next value is missing", () => {
    expect(
      resampleInstant([stamp(0, 60), stamp(1, null)]).map((o) => o.value),
    ).toEqual([60]);
  });
});

describe("the series list", () => {
  it("covers every quantity except SoC, which is not an average", () => {
    const all = Object.keys(quantities(rec()));
    expect(new Set([...AVERAGED, "bidi.battery/soc"])).toEqual(new Set(all));
  });
});
