import { describe, it, expect } from "@jest/globals";
import {
  assignEnergyToPeriods,
  assignProvenanceToPeriods,
  type EnergyReading,
  type EnergyWindow,
} from "@/lib/run-tracking/energy";
import {
  blendLoadIntensities,
  constantIntensity,
  stepIntensity,
  type IntensitySeries,
} from "@/lib/run-tracking/intensity";
import type {
  FlowSeries,
  SourceIntensity,
} from "@/lib/aggregation/flow-matrix-core";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function r(tMs: number, value: number | null): EnergyReading {
  return { tMs, value };
}

describe("assignEnergyToPeriods", () => {
  it("computes energy as last − first within the window (Wh→kWh, 3dp)", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 2 * MIN }];
    const readings = [r(T0, 100), r(T0 + MIN, 110), r(T0 + 2 * MIN, 130)];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.03]);
  });

  it("handles a counter reset via forward positive deltas", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 3 * MIN }];
    const readings = [
      r(T0, 100),
      r(T0 + MIN, 110), // +10
      r(T0 + 2 * MIN, 5), // reset (drop -105)
      r(T0 + 3 * MIN, 15), // +10
    ];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.02]);
  });

  it("returns null when fewer than two readings fall in the window", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    expect(assignEnergyToPeriods(windows, [r(T0, 100)], T0)).toEqual([null]);
    expect(assignEnergyToPeriods(windows, [], T0)).toEqual([null]);
  });

  it("uses nowMs as the upper bound for an open window", () => {
    const now = T0 + 2 * MIN;
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: null }];
    const readings = [r(T0, 100), r(T0 + MIN, 150), r(T0 + 2 * MIN, 250)];
    expect(assignEnergyToPeriods(windows, readings, now)).toEqual([0.15]);
  });

  it("excludes readings outside the window and ignores nulls", () => {
    const windows: EnergyWindow[] = [
      { startMs: T0 + MIN, endMs: T0 + 2 * MIN },
    ];
    const readings = [
      r(T0, 100), // before window
      r(T0 + MIN, 110),
      r(T0 + 90_000, null), // null ignored
      r(T0 + 2 * MIN, 140),
      r(T0 + 3 * MIN, 999), // after window
    ];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.03]);
  });

  it("aligns results to windows by index", () => {
    const windows: EnergyWindow[] = [
      { startMs: T0, endMs: T0 + MIN },
      { startMs: T0 + 2 * MIN, endMs: T0 + 3 * MIN },
    ];
    const readings = [
      r(T0, 100),
      r(T0 + MIN, 120),
      r(T0 + 2 * MIN, 200),
      r(T0 + 3 * MIN, 260),
    ];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0.02, 0.06]);
  });
});

/** Daylesford's prod device-1 constants (config.batteryProvenance.generatorSource). */
const DIESEL = constantIntensity({ priceC: 70, gPerKwh: 1000, renewable: 0 });

describe("assignProvenanceToPeriods", () => {
  it("prices a run at the constant factors (the degenerate integral)", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 2 * MIN }];
    // 100 Wh → 130 Wh = 0.03 kWh.
    const readings = [r(T0, 100), r(T0 + MIN, 110), r(T0 + 2 * MIN, 130)];
    expect(assignProvenanceToPeriods(windows, readings, DIESEL, T0)).toEqual([
      { costC: 0.03 * 70, emissionsG: 0.03 * 1000, renewableKwh: 0 },
    ]);
  });

  it("agrees with energy × factor for a constant series", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 3 * MIN }];
    const readings = [
      r(T0, 0),
      r(T0 + MIN, 1234),
      r(T0 + 2 * MIN, 2000),
      r(T0 + 3 * MIN, 3290),
    ];
    const [energyKwh] = assignEnergyToPeriods(windows, readings, T0);
    const [prov] = assignProvenanceToPeriods(windows, readings, DIESEL, T0);
    expect(prov.costC).toBeCloseTo(energyKwh! * 70, 9);
    expect(prov.emissionsG).toBeCloseTo(energyKwh! * 1000, 9);
  });

  it("is slice-decomposable: unequal slices sum to the whole-run figure", () => {
    // THE GATE for the run-period-provenance design: the per-slice integral must
    // equal the whole-run figure. Trivially true for a constant series — and the regression guard
    // for the day a time-varying (load-side blend) series lands.
    const varying: IntensitySeries = {
      // A price that steps mid-run, so decomposition is a real claim and not an identity.
      at: (tMs) => ({
        priceC: tMs < T0 + 3 * MIN ? 40 : 90,
        gPerKwh: 1000,
        renewable: 0.25,
      }),
    };
    // Deliberately UNEVEN steps (the counter's own cadence is not uniform).
    const readings = [
      r(T0, 0),
      r(T0 + MIN, 500),
      r(T0 + 3 * MIN, 900),
      r(T0 + 4 * MIN, 2400),
      r(T0 + 7 * MIN, 3000),
    ];
    const whole: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 7 * MIN }];
    const [full] = assignProvenanceToPeriods(whole, readings, varying, T0);

    // Hand-computed: 0.5 kWh @40 + 0.4 @90 + 1.5 @90 + 0.6 @90 = 20 + 36 + 135 + 54.
    expect(full.costC).toBeCloseTo(245, 9);
    expect(full.emissionsG).toBeCloseTo(3.0 * 1000, 9);
    expect(full.renewableKwh).toBeCloseTo(0.75, 9);

    // Now cut the SAME readings into two adjacent sub-windows at a reading boundary and check the
    // parts sum to the whole. (The shared reading is counted once — it opens the second slice.)
    const parts: EnergyWindow[] = [
      { startMs: T0, endMs: T0 + 3 * MIN },
      { startMs: T0 + 3 * MIN, endMs: T0 + 7 * MIN },
    ];
    const split = assignProvenanceToPeriods(parts, readings, varying, T0);
    expect(split[0].costC! + split[1].costC!).toBeCloseTo(full.costC!, 9);
    expect(split[0].emissionsG! + split[1].emissionsG!).toBeCloseTo(
      full.emissionsG!,
      9,
    );
    expect(split[0].renewableKwh! + split[1].renewableKwh!).toBeCloseTo(
      full.renewableKwh!,
      9,
    );
  });

  it("drops counter resets exactly as the energy path does", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 3 * MIN }];
    const readings = [
      r(T0, 100),
      r(T0 + MIN, 110), // +10 Wh
      r(T0 + 2 * MIN, 5), // reset
      r(T0 + 3 * MIN, 15), // +10 Wh
    ];
    // 0.02 kWh, same as assignEnergyToPeriods' reset case.
    expect(
      assignProvenanceToPeriods(windows, readings, DIESEL, T0)[0].costC,
    ).toBeCloseTo(0.02 * 70, 9);
  });

  it("nulls each factor independently — never reports 0 for an unknown", () => {
    const emissionsOnly = constantIntensity({
      priceC: null,
      gPerKwh: 800,
      renewable: null,
    });
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    const readings = [r(T0, 0), r(T0 + MIN, 1000)];
    expect(
      assignProvenanceToPeriods(windows, readings, emissionsOnly, T0),
    ).toEqual([{ costC: null, emissionsG: 800, renewableKwh: null }]);
  });

  it("reports a known $0.00 for a run whose counter never advances", () => {
    // A start that aborts after 40 s: two readings, no delta. assignEnergyToPeriods calls that a
    // KNOWN 0.000 kWh, so the provenance must be a known zero too — reporting null here would have
    // the same run's energy and cost disagree about whether anything is known.
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    const readings = [r(T0, 128_450), r(T0 + MIN, 128_450)];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0]);
    expect(assignProvenanceToPeriods(windows, readings, DIESEL, T0)).toEqual([
      { costC: 0, emissionsG: 0, renewableKwh: 0 },
    ]);
  });

  it("returns all-null when fewer than two readings fall in the window", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    expect(
      assignProvenanceToPeriods(windows, [r(T0, 100)], DIESEL, T0),
    ).toEqual([{ costC: null, emissionsG: null, renewableKwh: null }]);
  });

  it("bounds an open run at nowMs, so a partial figure tracks energy-so-far", () => {
    const now = T0 + 2 * MIN;
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: null }];
    const readings = [
      r(T0, 100),
      r(T0 + MIN, 150),
      r(T0 + 2 * MIN, 250),
      r(T0 + 5 * MIN, 9999), // in the future relative to `now` — must not count
    ];
    expect(
      assignProvenanceToPeriods(windows, readings, DIESEL, now)[0].costC,
    ).toBeCloseTo(0.15 * 70, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// The load-side blend — the provider half of run provenance (the tests above cover the integrator
// half). These two functions together turn the battery-provenance fold into an `IntensitySeries`,
// and both have one specific way of being subtly, invisibly wrong.
// ---------------------------------------------------------------------------------------------

/** A source that generates a constant `kw` across the whole timeline. */
function src(path: string, kw: number, n: number): FlowSeries {
  return { path, power: new Array<number | null>(n).fill(kw) };
}

/** A per-source intensity that is constant across `n` intervals. */
function si(
  n: number,
  price: number | null,
  g: number | null,
  ren: number | null,
): SourceIntensity {
  return {
    price: new Array<number | null>(n).fill(price),
    emissions: new Array<number | null>(n).fill(g),
    renewable: new Array<number | null>(n).fill(ren),
    selfRenewable: new Array<number | null>(n).fill(null),
    estimated: new Array<boolean>(n).fill(false),
  };
}

describe("stepIntensity", () => {
  // timeline boundaries → 2 steps: [T0,T0+5) and [T0+5,T0+10]
  const timeline = [T0, T0 + 5 * MIN, T0 + 10 * MIN];
  const samples = [
    { priceC: 10, gPerKwh: 100, renewable: 0.1 },
    { priceC: 20, gPerKwh: 200, renewable: 0.2 },
  ];
  const s = stepIntensity(timeline, samples);

  it("is RIGHT-CLOSED: a boundary instant reads the step that ENDS there", () => {
    // 🛑 THE OFF-BY-ONE GUARD. `assignProvenanceToPeriods` prices a counter slice at its LATER
    // reading, so the instant handed to `at()` is when energy FINISHED accruing. A left-closed
    // lookup (`timeline[i] <= tMs`) agrees with this for every slice strictly inside an interval —
    // which is most of them, and why the bug would survive casual testing — and silently jumps a
    // step for any slice ending exactly on a 5-minute boundary, pricing that energy at the interval
    // AFTER the one it accrued in.
    expect(s.at(T0 + MIN).priceC).toBe(10); // inside step 0
    expect(s.at(T0 + 5 * MIN - 1).priceC).toBe(10); // just before the boundary
    expect(s.at(T0 + 5 * MIN).priceC).toBe(10); // ON the boundary → still step 0
    expect(s.at(T0 + 5 * MIN + 1).priceC).toBe(20); // just after → step 1
    expect(s.at(T0 + 9 * MIN).priceC).toBe(20);
    expect(s.at(T0 + 10 * MIN).priceC).toBe(20); // the final boundary → the step ending there
  });

  it("has no interval for an accrual ending at the very first boundary", () => {
    // That energy accrued BEFORE this window — there is no step to price it at, and inventing one
    // would price it off a neighbouring interval.
    expect(s.at(T0).priceC).toBeNull();
  });

  it("is null outside the loaded window — never the nearest edge", () => {
    // A run reaching past the window the series was resolved for loses provenance for those slices.
    // Clamping instead would price them at a factor from a different time, silently.
    expect(s.at(T0 - 1)).toEqual({
      priceC: null,
      gPerKwh: null,
      renewable: null,
    });
    expect(s.at(T0 - MIN)).toEqual({
      priceC: null,
      gPerKwh: null,
      renewable: null,
    });
    expect(s.at(T0 + 10 * MIN + 1)).toEqual({
      priceC: null,
      gPerKwh: null,
      renewable: null,
    });
  });

  it("is null for a timeline too short to have a step", () => {
    expect(stepIntensity([T0], []).at(T0).priceC).toBeNull();
  });
});

describe("blendLoadIntensities", () => {
  const timeline = [T0, T0 + 5 * MIN, T0 + 10 * MIN];
  const N = timeline.length;

  it("weights each source by its share of generation", () => {
    // 3 kW solar (free, renewable) + 1 kW grid (50c, 900g, 20% renewable) → solar takes 75%.
    const sources = [src("source.solar", 3, N), src("source.grid", 1, N)];
    const [step] = blendLoadIntensities(
      timeline,
      sources,
      [],
      [si(N, 0, 0, 1), si(N, 50, 900, 0.2)],
    );
    expect(step.priceC).toBeCloseTo(0.25 * 50, 9);
    expect(step.gPerKwh).toBeCloseTo(0.25 * 900, 9);
    expect(step.renewable).toBeCloseTo(0.75 * 1 + 0.25 * 0.2, 9);
  });

  it("drops an unknown factor from the DENOMINATOR too, not just the numerator", () => {
    // Grid emissions unknown ⇒ the step is priced off the sources that DO know, at their own
    // intensity — not diluted toward zero by counting the unknown source's share as 0 g.
    const sources = [src("source.solar", 3, N), src("source.grid", 1, N)];
    const [step] = blendLoadIntensities(
      timeline,
      sources,
      [],
      [si(N, 0, 0, 1), si(N, 50, null, 0.2)],
    );
    expect(step.gPerKwh).toBe(0); // solar's 0 g at 100% of the KNOWN weight
    expect(step.priceC).toBeCloseTo(0.25 * 50, 9); // price still blends both
  });

  it("ignores a source with no intensity at all (e.g. source.generator)", () => {
    const sources = [src("source.solar", 1, N), src("source.generator", 3, N)];
    const [step] = blendLoadIntensities(
      timeline,
      sources,
      [],
      [si(N, 12, 0, 1), null],
    );
    expect(step.priceC).toBe(12);
  });

  it("is null when nothing generated, and when no source knows the factor", () => {
    const idle = [src("source.solar", 0, N)];
    expect(
      blendLoadIntensities(timeline, idle, [], [si(N, 10, 10, 1)])[0],
    ).toEqual({ priceC: null, gPerKwh: null, renewable: null });
    const blind = [src("source.solar", 2, N)];
    expect(
      blendLoadIntensities(timeline, blind, [], [si(N, null, null, null)])[0],
    ).toEqual({ priceC: null, gPerKwh: null, renewable: null });
  });

  it("emits one step per INTERVAL, not per timeline boundary", () => {
    const sources = [src("source.solar", 1, N)];
    expect(
      blendLoadIntensities(timeline, sources, [], [si(N, 1, 1, 1)]),
    ).toHaveLength(timeline.length - 1);
  });

  it("switches to exact-energy weights when only a LOAD is metered", () => {
    // The reason `loads` is threaded through at all: `anyExact` is set by scanning sources AND
    // loads, and it decides whether weights are kWh or kW. Here solar's power (1 kW) and grid's
    // (3 kW) would blend 25/75 in power mode; in exact mode the same powers become kWh over the
    // interval and the ratio is unchanged — what must NOT happen is the two call sites disagreeing
    // about which mode they are in.
    const sources = [src("source.solar", 1, N), src("source.grid", 3, N)];
    const meteredLoad: FlowSeries = {
      path: "load.ev",
      power: new Array<number | null>(N).fill(4),
      energyKwh: new Array<number | null>(N).fill(0.33),
    };
    const [step] = blendLoadIntensities(
      timeline,
      sources,
      [meteredLoad],
      [si(N, 0, 0, 1), si(N, 40, 800, 0)],
    );
    expect(step.priceC).toBeCloseTo(0.75 * 40, 9);
  });
});

describe("the blend feeding the integrator", () => {
  it("prices a run at the blend in force at each slice", () => {
    // Solar-only for the first 5 min (free), grid-only after (60c) — a charge session straddling
    // the changeover must pay for only the second half's kWh.
    const timeline = [T0, T0 + 5 * MIN, T0 + 10 * MIN];
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [4, 0, 0] },
      { path: "source.grid", power: [0, 4, 4] },
    ];
    const steps = blendLoadIntensities(
      timeline,
      sources,
      [],
      [si(3, 0, 0, 1), si(3, 60, 900, 0)],
    );
    const series = stepIntensity(timeline, steps);

    const readings = [
      r(T0, 0),
      r(T0 + 5 * MIN, 1000), // 1 kWh on solar
      r(T0 + 10 * MIN, 3000), // 2 kWh on grid
    ];
    const [prov] = assignProvenanceToPeriods(
      [{ startMs: T0, endMs: T0 + 10 * MIN }],
      readings,
      series,
      T0 + 10 * MIN,
    );
    expect(prov.costC).toBeCloseTo(2 * 60, 9); // the solar kWh is free
    expect(prov.emissionsG).toBeCloseTo(2 * 900, 9);
    expect(prov.renewableKwh).toBeCloseTo(1, 9); // 1 kWh at 100%, 2 kWh at 0%
  });
});
