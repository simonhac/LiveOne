import { describe, it, expect } from "@jest/globals";
import {
  assignEnergyToPeriods,
  assignProvenanceToPeriods,
  type EnergyReading,
  type EnergyWindow,
  type SignalSample,
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

// ---------------------------------------------------------------------------------------------
// Partitioning the counter across the run boundary. These are the tests for the defect that had the
// EV run totals sitting ~1.0 kWh under the Sankey's `load.ev` for the same week.
// ---------------------------------------------------------------------------------------------

/** A signal that is off until `onMs` and flat at `watts` after — the EV charger's actual shape. */
function chargerSignal(
  onMs: number,
  offMs: number,
  watts: number,
): SignalSample[] {
  const out: SignalSample[] = [];
  for (let t = T0 - MIN; t <= T0 + 10 * MIN; t += 30_000)
    out.push({ tMs: t, value: t >= onMs && t < offMs ? watts : 0 });
  return out;
}

describe("allocateCounterToWindows", () => {
  // The Kinkora shape, minimised: a counter that only ticks every ~2 minutes in fixed quanta, and a
  // run that starts BETWEEN two of those ticks. The first tick after the start reports energy that
  // accrued after the charger came on — clipping to "readings inside the window" discarded it.
  const QUANTUM = 400; // Wh, ~ the real charger's tick
  const chunky = [
    r(T0, 0), // charger off
    r(T0 + 2 * MIN, QUANTUM), // first tick: accrued AFTER the run started
    r(T0 + 4 * MIN, 2 * QUANTUM),
    r(T0 + 6 * MIN, 3 * QUANTUM),
  ];
  const runFrom1 = [{ startMs: T0 + MIN, endMs: T0 + 6 * MIN }];
  const signal = chargerSignal(T0 + MIN, T0 + 6 * MIN, 5000);

  it("recovers the WHOLE counter step that straddles the run's start", () => {
    // The old clip rule took the first reading INSIDE the window as its baseline and returned
    // 1200−400 = 800 Wh, discarding a quantum that had accrued after the charger came on. All 1200
    // belong to the run: the charger drew nothing before it, and the allocator reconstructs the
    // 0→5 kW switch as a STEP at the boundary the detector chose rather than a ramp through it.
    expect(assignEnergyToPeriods(runFrom1, chunky, T0, signal)).toEqual([1.2]);
  });

  it("leaves nothing in the gap ahead of the run", () => {
    // The counterpart of the above, and the reason it is safe: interpolating across the boundary
    // would book part of the run's first quantum to a period this very system says the device was
    // off. Energy still conserves — the gap's share is zero, not discarded.
    const [before, during] = assignEnergyToPeriods(
      [
        { startMs: T0, endMs: T0 + MIN }, // the gap ahead of the run
        { startMs: T0 + MIN, endMs: T0 + 6 * MIN }, // the run
      ],
      chunky,
      T0,
      signal,
    );
    expect(before).toBeCloseTo(0, 9);
    expect(before! + during!).toBeCloseTo(1.2, 9); // every metered Wh landed somewhere
  });

  it("splits a straddling step by the signal, not by the clock", () => {
    // One long counter step whose energy all flowed in a short burst at the end: a two-minute charge
    // inside a ten-minute reporting gap. The clock says the run's 2 of 10 minutes earn 20% of the
    // step; the signal knows the other 8 minutes drew nothing.
    const sparse = [r(T0, 0), r(T0 + 10 * MIN, 1000)];
    const burst = chargerSignal(T0 + 8 * MIN, T0 + 10 * MIN, 5000);
    const window = [{ startMs: T0 + 8 * MIN, endMs: T0 + 10 * MIN }];

    const [bySignal] = assignEnergyToPeriods(window, sparse, T0, burst);
    expect(bySignal).toBeCloseTo(1.0, 9); // all of it — nothing flowed in the idle 8 minutes

    const [byClock] = assignEnergyToPeriods(window, sparse, T0);
    expect(byClock).toBeCloseTo(0.2, 9); // what a signal-blind split would have booked
  });

  it("prices a step spanning two factor intervals WHOLLY at the later one", () => {
    // 🛑 THE ALIGNMENT WITH `agg_5m.delta`, and it is deliberately NOT the intuitive answer.
    //
    // Splitting this step at the 5-minute boundary and pricing each half at its own factor looks
    // strictly more accurate. It is measurably wrong for this system: `agg_5m.delta` for a
    // `transform='d'` counter is `last − previousLast`, so a raw step straddling a boundary is booked
    // WHOLLY to the interval holding its later reading — and the flow matrix prices that interval's
    // energy at that interval's blend. The right-closed rule here reproduces exactly that. Measured
    // on a Kinkora week, splitting moved the run total $0.042 (0.45%) AWAY from a Sankey it had been
    // matching to 4 decimal places.
    const boundary = T0 + 5 * MIN;
    const stepped: IntensitySeries = {
      at: (tMs) => ({
        priceC: tMs <= boundary ? 10 : 50,
        gPerKwh: null,
        renewable: null,
        // Priced but with emissions and renewable unknown — the matrix's condition fires on any one
        // of the three, so this energy is estimated even though it has a cost.
        estimatedFraction: 1,
      }),
    };
    // One 1 kWh step from T0+4min to T0+6min — half either side of the boundary, at a flat signal.
    const readings = [r(T0 + 4 * MIN, 0), r(T0 + 6 * MIN, 1000)];
    const flat = Array.from({ length: 30 }, (_, i) => ({
      tMs: T0 + i * 30_000,
      value: 5000,
    }));
    const windows = [{ startMs: T0, endMs: T0 + 10 * MIN }];

    const [prov] = assignProvenanceToPeriods(
      windows,
      readings,
      stepped,
      T0,
      flat,
    );
    expect(prov.costC).toBeCloseTo(50, 6); // 1 kWh @ the interval it lands in — not 30c
    expect(assignEnergyToPeriods(windows, readings, T0, flat)).toEqual([1]);
  });

  it("conserves energy: a partition of a span sums to the whole span", () => {
    // THE property that makes this complete rather than merely less wrong. Deterministic LCG so a
    // failure is reproducible.
    let seed = 0x2f6e2b1;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let trial = 0; trial < 200; trial++) {
      // A ragged counter: uneven gaps, an occasional flat stretch, an occasional reset.
      const readings: EnergyReading[] = [];
      let t = T0;
      let v = 1000;
      for (let i = 0; i < 25; i++) {
        readings.push(r(t, v));
        t += Math.floor(20_000 + rnd() * 200_000);
        const roll = rnd();
        if (roll < 0.1)
          v = Math.floor(rnd() * 100); // counter reset
        else if (roll < 0.25)
          v += 0; // flat
        else v += Math.floor(rnd() * 900);
      }
      const lo = T0;
      const hi = t;
      const sig = Array.from({ length: 40 }, (_, i) => ({
        tMs: lo + ((hi - lo) * i) / 39,
        value: rnd() < 0.3 ? 0 : rnd() * 5000,
      }));

      const [whole] = assignEnergyToPeriods(
        [{ startMs: lo, endMs: hi }],
        readings,
        hi,
        sig,
      );

      // Cut [lo, hi] into 5 adjacent sub-windows at arbitrary interior points.
      const cuts = Array.from(
        { length: 4 },
        () => lo + Math.floor(rnd() * (hi - lo)),
      ).sort((a, b) => a - b);
      const edges = [lo, ...cuts, hi];
      const parts = edges
        .slice(0, -1)
        .map((s, i) => ({ startMs: s, endMs: edges[i + 1] }))
        .filter((w) => w.endMs > w.startMs);
      const sum = assignEnergyToPeriods(parts, readings, hi, sig).reduce(
        (a: number, b) => a + (b ?? 0),
        0,
      );
      // 3dp rounding happens per window, so the tolerance is the rounding, not the maths.
      expect(sum).toBeCloseTo(whole!, 2);
    }
  });

  it("still reports a KNOWN zero for a window a flat counter spans", () => {
    // Coverage is decided before the reset/no-delta guard, so "the meter says nothing happened" and
    // "the meter said nothing" stay distinct even when the window sits inside one flat step.
    const flat = [r(T0, 5000), r(T0 + 10 * MIN, 5000)];
    const inside = [{ startMs: T0 + 2 * MIN, endMs: T0 + 3 * MIN }];
    expect(assignEnergyToPeriods(inside, flat, T0)).toEqual([0]);
    expect(assignProvenanceToPeriods(inside, flat, DIESEL, T0)).toEqual([
      { costC: 0, emissionsG: 0, renewableKwh: 0, estimatedKwh: 0 },
    ]);
  });

  it("still reports null for a window no counter step spans", () => {
    const readings = [r(T0, 100), r(T0 + MIN, 200)];
    const elsewhere = [{ startMs: T0 + 5 * MIN, endMs: T0 + 6 * MIN }];
    expect(assignEnergyToPeriods(elsewhere, readings, T0)).toEqual([null]);
    expect(assignProvenanceToPeriods(elsewhere, readings, DIESEL, T0)).toEqual([
      // estimatedKwh is null here too — not 0. The counter says nothing about this window, so there
      // is no energy to have an opinion about, exactly as for the three factors.
      { costC: null, emissionsG: null, renewableKwh: null, estimatedKwh: null },
    ]);
  });

  it("prices the recovered straddle at the factor in force when it accrued", () => {
    // Energy and provenance must move together: the quantum the old rule dropped has to arrive with
    // its own price, not be back-filled at the run's average.
    const [kwh] = assignEnergyToPeriods(runFrom1, chunky, T0, signal);
    const [prov] = assignProvenanceToPeriods(
      runFrom1,
      chunky,
      DIESEL,
      T0,
      signal,
    );
    expect(prov.costC).toBeCloseTo(kwh! * 70, 6);
    expect(prov.emissionsG).toBeCloseTo(kwh! * 1000, 6);
  });
});

/** Daylesford's prod device-1 constants (config.batteryProvenance.generatorSource). */
const DIESEL = constantIntensity({
  priceC: 70,
  gPerKwh: 1000,
  renewable: 0,
  // Fully configured: price, emissions and renewable fraction all known, so none of a diesel run's
  // energy is estimated. (`resolveIntensitySeries` sets this to 1 when `pricePerKwh` is absent.)
  estimatedFraction: 0,
});

describe("assignProvenanceToPeriods", () => {
  it("prices a run at the constant factors (the degenerate integral)", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 2 * MIN }];
    // 100 Wh → 130 Wh = 0.03 kWh.
    const readings = [r(T0, 100), r(T0 + MIN, 110), r(T0 + 2 * MIN, 130)];
    expect(assignProvenanceToPeriods(windows, readings, DIESEL, T0)).toEqual([
      {
        costC: 0.03 * 70,
        emissionsG: 0.03 * 1000,
        renewableKwh: 0,
        estimatedKwh: 0,
      },
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
        estimatedFraction: 0,
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
      // Price and renewable unknown ⇒ the matrix's condition fires on every contribution, so all of
      // this run's energy is estimated. The cost is ABSENT and the confidence figure says why.
      estimatedFraction: 1,
    });
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    const readings = [r(T0, 0), r(T0 + MIN, 1000)];
    expect(
      assignProvenanceToPeriods(windows, readings, emissionsOnly, T0),
    ).toEqual([
      { costC: null, emissionsG: 800, renewableKwh: null, estimatedKwh: 1 },
    ]);
  });

  it("reports a fully-unpriceable run's WHOLE energy as estimated, never 0", () => {
    // 🛑 THE READING THIS COLUMN EXISTS TO PREVENT. Under the aligned blend, energy from a source
    // with no known intensity contributes nothing to the cost — so a run like this has no cost at
    // all, and a 0 here would state that none of it was estimated: a claim of perfect confidence
    // about a run nothing could price. `estimatedKwh` must equal the run's energy instead.
    const unknown = constantIntensity({
      priceC: null,
      gPerKwh: null,
      renewable: null,
      estimatedFraction: 1,
    });
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 2 * MIN }];
    const readings = [r(T0, 100), r(T0 + MIN, 600), r(T0 + 2 * MIN, 1100)];
    const [energyKwh] = assignEnergyToPeriods(windows, readings, T0);
    const [prov] = assignProvenanceToPeriods(windows, readings, unknown, T0);
    expect(energyKwh).toBeCloseTo(1.0, 9);
    expect(prov.costC).toBeNull();
    expect(prov.estimatedKwh).toBeCloseTo(energyKwh!, 9);
  });

  it("reports a known $0.00 for a run whose counter never advances", () => {
    // A start that aborts after 40 s: two readings, no delta. assignEnergyToPeriods calls that a
    // KNOWN 0.000 kWh, so the provenance must be a known zero too — reporting null here would have
    // the same run's energy and cost disagree about whether anything is known.
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    const readings = [r(T0, 128_450), r(T0 + MIN, 128_450)];
    expect(assignEnergyToPeriods(windows, readings, T0)).toEqual([0]);
    expect(assignProvenanceToPeriods(windows, readings, DIESEL, T0)).toEqual([
      { costC: 0, emissionsG: 0, renewableKwh: 0, estimatedKwh: 0 },
    ]);
  });

  it("returns all-null when fewer than two readings fall in the window", () => {
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + MIN }];
    expect(
      assignProvenanceToPeriods(windows, [r(T0, 100)], DIESEL, T0),
    ).toEqual([
      { costC: null, emissionsG: null, renewableKwh: null, estimatedKwh: null },
    ]);
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
    { priceC: 10, gPerKwh: 100, renewable: 0.1, estimatedFraction: 0 },
    { priceC: 20, gPerKwh: 200, renewable: 0.2, estimatedFraction: 0 },
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
    //
    // …and `estimatedFraction` is 1 there, not 0: those slices are not merely unpriced, they are
    // energy nothing is known about, which is precisely what the confidence figure reports.
    const OUTSIDE = {
      priceC: null,
      gPerKwh: null,
      renewable: null,
      estimatedFraction: 1,
    };
    expect(s.at(T0 - 1)).toEqual(OUTSIDE);
    expect(s.at(T0 - MIN)).toEqual(OUTSIDE);
    expect(s.at(T0 + 10 * MIN + 1)).toEqual(OUTSIDE);
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

  it("keeps an UNPRICEABLE source in the denominator — its energy is unpriced, not re-rated", () => {
    // Solar (75% of the pool) has no known price; grid (25%) is 50c. Only a quarter of the load's
    // energy is priceable, so the factor applied to the WHOLE slice is 0.25 × 50.
    //
    // 🛑 The old rule renormalised onto the KNOWN share and returned the full 50 — pricing
    // solar-supplied energy at the grid tariff. That is what put the runs above the Sankey on prod.
    // `computeFlowAccounting` gives the unpriceable source its own energy edge and contributes
    // nothing from it; this must agree. See the parity test in intensity-blend-parity.test.ts.
    const sources = [src("source.solar", 3, N), src("source.grid", 1, N)];
    const [step] = blendLoadIntensities(
      timeline,
      sources,
      [],
      [si(N, null, 0, 1), si(N, 50, 900, 0.2)],
    );
    expect(step.priceC).toBeCloseTo(0.25 * 50, 9);
    // Note this is the SAME answer a known-zero solar price gives (the test above) — under the
    // aligned rule "unknown" and "free" both contribute nothing to the cost. They are distinguished
    // by the accounting's `estimated_kwh`, never by the cost itself.
    expect(step.gPerKwh).toBeCloseTo(0.25 * 900, 9);
  });

  it("a source with NO intensity at all (e.g. source.generator) keeps its share of the pool", () => {
    // The generator supplies 3 of the 4 kW and cannot be priced, so only the solar quarter carries a
    // cost: 12c × ¼. Previously this reported the full 12c, i.e. it billed generator-supplied energy
    // at the solar rate.
    const sources = [src("source.solar", 1, N), src("source.generator", 3, N)];
    const [step] = blendLoadIntensities(
      timeline,
      sources,
      [],
      [si(N, 12, 0, 1), null],
    );
    expect(step.priceC).toBeCloseTo(0.25 * 12, 9);
  });

  it("is null when nothing generated, and when no source knows the factor", () => {
    // Both are 100% estimated: an empty pool has nothing to attribute the load's energy to, and the
    // blind source supplies all of it with no factor known. Absent cost, and a reason for it.
    const idle = [src("source.solar", 0, N)];
    expect(
      blendLoadIntensities(timeline, idle, [], [si(N, 10, 10, 1)])[0],
    ).toEqual({
      priceC: null,
      gPerKwh: null,
      renewable: null,
      estimatedFraction: 1,
    });
    const blind = [src("source.solar", 2, N)];
    expect(
      blendLoadIntensities(timeline, blind, [], [si(N, null, null, null)])[0],
    ).toEqual({
      priceC: null,
      gPerKwh: null,
      renewable: null,
      estimatedFraction: 1,
    });
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
