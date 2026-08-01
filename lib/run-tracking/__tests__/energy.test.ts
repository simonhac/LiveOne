import { describe, it, expect } from "@jest/globals";
import {
  assignEnergyToPeriods,
  assignProvenanceToPeriods,
  type EnergyReading,
  type EnergyWindow,
} from "@/lib/run-tracking/energy";
import {
  constantIntensity,
  type IntensitySeries,
} from "@/lib/run-tracking/intensity";

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
