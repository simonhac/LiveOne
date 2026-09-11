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
  ACCUMULATED,
  AVERAGED,
  accumulatorIncrements,
  splitIncrement,
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

  it("lands a stamp on the bucket it ENDS, not the one it starts", () => {
    // 🛑 A bucket is (end-5, end], so an instantaneous reading at T is the last sample of the bucket
    // ENDING at T — interval_start T-5. Measured against LiveOne over 2026-08: r = 0.999996 and
    // medAbs 0.011 % at this alignment, against 0.999921 and 0.044 % one bucket later. The first cut
    // of this function was wrong by exactly one interval, which on a slowly-moving series like SoC
    // looks entirely plausible and is invisible to everything downstream.
    const out = resampleInstant([stamp(0, 60), stamp(1, 63)]);
    expect(out.slice(0, 3).map((o) => [o.startMs - T, o.value])).toEqual([
      [-FIVE_MIN_MS, 60],
      [0, 61],
      [FIVE_MIN_MS, 62],
    ]);
  });

  it("agrees with where the averages put the same window's last bucket", () => {
    // Cross-check between the two resamplers, which reach it independently: a window (T-15, T]
    // covers the buckets starting T-15, T-10, T-5 — so a reading AT T belongs to the one at T-5.
    const avg = resampleAverages([{ tMs: T, value: 1 }]);
    const inst = resampleInstant([{ tMs: T, value: 1 }]);
    expect(inst[0].startMs).toBe(avg[avg.length - 1].startMs);
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

/**
 * The energy counters: SP LINK's DAY accumulators → LiveOne's LIFETIME counters.
 *
 * 🛑 Two properties must not break. A window's energy has to survive the split into thirds exactly
 * — `recomputeAgg1dForDay` sums 5-minute deltas, so a split that lost a fraction would show up as a
 * short day. And the midnight reset has to be read as a reset: treating the post-reset value as an
 * increment is harmless (it IS one), but treating a normal reading as one would invent a whole
 * day-to-date of energy in a single interval.
 */
describe("accumulatorIncrements", () => {
  const at = (i: number) => T + i * FIFTEEN_MIN_MS;

  it("differences a rising accumulator", () => {
    const out = accumulatorIncrements([
      { tMs: at(0), value: 10 },
      { tMs: at(1), value: 12.5 },
      { tMs: at(2), value: 15 },
    ]);
    // The first window has no predecessor, so its increment is unknowable — not zero, and not the
    // reading itself, which is a day-to-date total.
    expect(out.map((o) => o.increment)).toEqual([null, 2.5, 2.5]);
  });

  it("reads a FALL as the day rolling over, and the new value as the first window's energy", () => {
    const out = accumulatorIncrements([
      { tMs: at(0), value: 29.2069 },
      { tMs: at(1), value: 0.6832 },
      { tMs: at(2), value: 1.3664 },
    ]);
    expect(out[1].increment).toBeCloseTo(0.6832, 6);
    expect(out[2].increment).toBeCloseTo(0.6832, 6);
  });

  it("refuses to difference across a hole", () => {
    const out = accumulatorIncrements([
      { tMs: at(0), value: 10 },
      { tMs: at(2), value: 20 }, // one window missing between them
    ]);
    // Differencing here would attribute two windows of energy to one.
    expect(out[1].increment).toBeNull();
  });

  it("yields null for a blank reading without breaking the chain after it", () => {
    const out = accumulatorIncrements([
      { tMs: at(0), value: 10 },
      { tMs: at(1), value: null },
      { tMs: at(2), value: 15 },
    ]);
    expect(out[1].increment).toBeNull();
    // at(2)'s predecessor is at(0), two windows back — unknowable, not 5.
    expect(out[2].increment).toBeNull();
  });
});

describe("splitIncrement", () => {
  it("preserves the window's energy exactly, whatever the shape", () => {
    for (const shape of [
      [1, 2, 3],
      [10, 0, 0],
      [0.001, 1000, 7],
    ] as Array<[number, number, number]>) {
      const out = splitIncrement(300, shape);
      expect(out[0] + out[1] + out[2]).toBeCloseTo(300, 9);
    }
  });

  it("weights by the shape", () => {
    expect(splitIncrement(600, [1, 2, 3])).toEqual([100, 200, 300]);
  });

  it("falls back to equal thirds with no usable shape", () => {
    expect(splitIncrement(300, null)).toEqual([100, 100, 100]);
    // All non-positive: a counter cannot run backwards, so nothing here can weight it.
    expect(splitIncrement(300, [0, 0, 0])).toEqual([100, 100, 100]);
    expect(splitIncrement(300, [-1, -2, -3])).toEqual([100, 100, 100]);
  });

  it("clamps a single negative bucket rather than discarding the window", () => {
    const out = splitIncrement(300, [-5, 1, 1]);
    expect(out[0]).toBe(0);
    expect(out[0] + out[1] + out[2]).toBeCloseTo(300, 9);
  });

  it("never emits a negative bucket from a positive increment", () => {
    for (const shape of [
      [-1, 5, 5],
      [5, -1, 5],
      [5, 5, -1],
    ] as Array<[number, number, number]>)
      for (const v of splitIncrement(120, shape))
        expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("ACCUMULATED", () => {
  it("names solar's two halves with the shunt inverted, as the power identity does", () => {
    const solar = ACCUMULATED.find((a) => a.series === "source.solar/energy")!;
    expect(solar.columns).toEqual([
      { name: "shunt1_accumulated_kwh", scale: -1 },
      { name: "ac_coupled_energy_sample_kwh", scale: 1 },
    ]);
  });

  it("covers every energy counter the six-point repair needs", () => {
    expect(ACCUMULATED.map((a) => a.series).sort()).toEqual([
      "bidi.battery.charge/energy",
      "bidi.battery.discharge/energy",
      "bidi.grid.export/energy",
      "bidi.grid.import/energy",
      "load/energy",
      "source.solar/energy",
    ]);
  });
});
