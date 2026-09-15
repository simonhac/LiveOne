/**
 * Energy for a detector with NO counter — integrating the run's own power signal.
 *
 * The case: the Sigenergy EV charger publishes `load.ev/power` and no cumulative register, so its
 * runs stored NULL energy. Honest, and useless — the card and the chart tooltip showed "—" against
 * a six-hour charge whose kWh the site's own flow matrix had already integrated from that very
 * point. These pin that the derived figure is right, that it is still UNKNOWN when it genuinely is,
 * and — the reason the allocator returns slices rather than a number — that provenance rides along.
 */
import { describe, it, expect } from "@jest/globals";
import {
  allocatePowerToWindows,
  energyFromAllocation,
  provenanceFromAllocation,
  type EnergyWindow,
  type SignalSample,
} from "@/lib/run-tracking/energy";
import { detectRunPeriods, type DetectConfig } from "@/lib/run-tracking/detect";
import { constantIntensity } from "@/lib/run-tracking/intensity";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const NOW = T0 + 100 * MIN;

const p = (tMs: number, value: number | null): SignalSample => ({ tMs, value });

describe("allocatePowerToWindows", () => {
  it("integrates a flat load to power × time", () => {
    // 6 kW held across 60 minutes ⇒ 6 kWh, whatever the sample spacing.
    const signal = [0, 15, 30, 45, 60].map((m) => p(T0 + m * MIN, 6000));
    const windows: EnergyWindow[] = [{ startMs: T0, endMs: T0 + 60 * MIN }];
    const [kwh] = energyFromAllocation(
      allocatePowerToWindows(windows, signal, NOW),
    );
    expect(kwh).toBeCloseTo(6, 6);
  });

  it("trapezoids a varying interior, holding the final interval at the run edge", () => {
    // 4 → 8 → 8 → 8 → 4 kW on a 15-minute cadence. The three interior segments trapezoid
    // (6, 8, 8 kW mean); the LAST one is held flat at its left value because the run end is a
    // transition — the shared edge reconstruction suppresses the ramp leading into a switch, which
    // is what stops a run's power leaking across its own boundary. Documented, not incidental.
    const signal = [4000, 8000, 8000, 8000, 4000].map((w, i) =>
      p(T0 + i * 15 * MIN, w),
    );
    const [kwh] = energyFromAllocation(
      allocatePowerToWindows(
        [{ startMs: T0, endMs: T0 + 60 * MIN }],
        signal,
        NOW,
      ),
    );
    expect(kwh).toBeCloseTo(((6 + 8 + 8 + 8) * 15) / 60, 6);
  });

  it("steps up AT the run boundary rather than ramping out of the preceding zero", () => {
    // The boundary case that matters. A `midpoint` start lands between the last off sample and the
    // first on sample; interpolating across it would charge the run a ramp it never drew, and would
    // leak the run's own power backwards into the idle gap.
    const signal = [p(T0, 0), p(T0 + 10 * MIN, 6000), p(T0 + 20 * MIN, 6000)];
    const [kwh] = energyFromAllocation(
      allocatePowerToWindows(
        [{ startMs: T0 + 5 * MIN, endMs: T0 + 20 * MIN }],
        signal,
        NOW,
      ),
    );
    // Full 6 kW for the whole 15 minutes from the boundary — not a ramp averaging less.
    expect(kwh).toBeCloseTo(1.5, 6);
  });

  it("reproduces the Kutis session: ~6.8 kW for 52 minutes", () => {
    // The run in the screenshot that read "— kWh": 11:58–12:50 at ~6.8 kW on a 5-minute cadence.
    const signal = Array.from({ length: 12 }, (_, i) =>
      p(T0 + i * 5 * MIN, 6800),
    );
    const [kwh] = energyFromAllocation(
      allocatePowerToWindows(
        [{ startMs: T0, endMs: T0 + 55 * MIN }],
        signal,
        NOW,
      ),
    );
    expect(kwh).toBeCloseTo((6.8 * 55) / 60, 2);
  });

  it("clips to the window rather than counting the whole sample interval", () => {
    // Half of a 6 kW hour is 3 kWh — the run boundary cuts the interval, it does not round it up.
    const signal = [p(T0, 6000), p(T0 + 60 * MIN, 6000)];
    const [kwh] = energyFromAllocation(
      allocatePowerToWindows(
        [{ startMs: T0, endMs: T0 + 30 * MIN }],
        signal,
        NOW,
      ),
    );
    expect(kwh).toBeCloseTo(3, 6);
  });

  it("returns UNKNOWN, not a known zero, when nothing bounds the window", () => {
    // 🛑 The distinction the whole `CounterSlice[] | null` contract exists for. One sample cannot
    // bound an interval; neither can samples that miss the window entirely.
    expect(
      energyFromAllocation(
        allocatePowerToWindows(
          [{ startMs: T0, endMs: T0 + 30 * MIN }],
          [p(T0, 6000)],
          NOW,
        ),
      ),
    ).toEqual([null]);
    expect(
      energyFromAllocation(
        allocatePowerToWindows(
          [{ startMs: T0, endMs: T0 + 30 * MIN }],
          [p(NOW, 6000), p(NOW + MIN, 6000)],
          NOW,
        ),
      ),
    ).toEqual([null]);
  });

  it("carries an open run up to nowMs", () => {
    const signal = [p(NOW - 60 * MIN, 6000), p(NOW, 6000)];
    const [kwh] = energyFromAllocation(
      allocatePowerToWindows(
        [{ startMs: NOW - 60 * MIN, endMs: null }],
        signal,
        NOW,
      ),
    );
    expect(kwh).toBeCloseTo(6, 6);
  });

  it("splits energy between two runs without double-counting", () => {
    const signal = [0, 30, 60, 90].map((m) => p(T0 + m * MIN, 6000));
    const alloc = allocatePowerToWindows(
      [
        { startMs: T0, endMs: T0 + 30 * MIN },
        { startMs: T0 + 60 * MIN, endMs: T0 + 90 * MIN },
      ],
      signal,
      NOW,
    );
    const [a, b] = energyFromAllocation(alloc);
    expect(a).toBeCloseTo(3, 6);
    expect(b).toBeCloseTo(3, 6);
  });

  it("feeds provenance the same way a counter does — the reason it returns slices", () => {
    // This is the payoff: a power-only detector gets cost/emissions/renewable through the SAME
    // `provenanceFromAllocation` the metered path uses, priced at the same per-slice instants.
    const signal = [p(T0, 6000), p(T0 + 60 * MIN, 6000)];
    const alloc = allocatePowerToWindows(
      [{ startMs: T0, endMs: T0 + 60 * MIN }],
      signal,
      NOW,
    );
    const [prov] = provenanceFromAllocation(
      alloc,
      constantIntensity({
        priceC: 30,
        gPerKwh: 700,
        renewable: 0.5,
        estimatedFraction: 0,
      }),
    );
    // 6 kWh at 30 c/kWh, 700 g/kWh, half renewable.
    expect(prov.costC).toBeCloseTo(180, 3);
    expect(prov.emissionsG).toBeCloseTo(4200, 0);
    expect(prov.renewableKwh).toBeCloseTo(3, 3);
  });
});

/**
 * The promise `allocatePowerToWindows` makes in prose — "the same trapezoid the flow matrix
 * integrates power with, so a run's kWh agrees with the Sankey band it sits under rather than
 * contradicting it" — asserted directly, end to end, detector included.
 *
 * Nothing checked it, and it was false. `boundaryMode: "midpoint"` was applied to the run's START
 * and never to its END, so a run of `n` on-samples spanned `(n − 0.5)` sample intervals while the
 * flow matrix integrated `n` of them. The shortfall is half an interval of run power PER RUN — a
 * flat 0.283 kWh on the Kutis charger (6.86 kW on a 300 s cadence) — so it reads as rounding on a
 * single long session and compounds with the number of sessions. Five sessions in a week put the
 * runs card at 68.6 kWh under a Sankey node saying 70.0.
 *
 * These go through `detectRunPeriods` on purpose: the defect lived in the boundaries, not in the
 * allocator, and a test that hand-writes the window cannot see it.
 */
describe("a run's energy agrees with the flow matrix's band", () => {
  const CADENCE = 5 * MIN; // the Sigenergy charger's poll interval
  const evCfg: DetectConfig = {
    lowerW: null,
    upperW: 100, // the live Kutis detector's threshold
    hysteresisW: 0,
    delayOnMs: 0,
    delayOffMs: 900_000,
    nowMs: T0 + 10_000 * MIN, // far past the tail, so every run closes
    boundaryMode: "midpoint",
  };

  /**
   * Exactly what `computeFlowAccounting` does to a power series with no energy overlay
   * (`lib/aggregation/flow-matrix-core.ts`): trapezoid every consecutive sample pair. This is the
   * number the Sankey's `load.ev` node carries.
   */
  function flowMatrixKwh(samples: SignalSample[]): number {
    let kwh = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].value;
      const b = samples[i].value;
      if (a === null || b === null) continue;
      kwh +=
        ((a + b) / 2) * ((samples[i].tMs - samples[i - 1].tMs) / 3_600_000);
    }
    return kwh / 1000;
  }

  /** Zeros, then `watts` one per `CADENCE`, then zeros — the shape of a charge session. */
  function session(watts: number[], leadingZeros = 2, trailingZeros = 2) {
    const values = [
      ...Array<number>(leadingZeros).fill(0),
      ...watts,
      ...Array<number>(trailingZeros).fill(0),
    ];
    return values.map((w, i) => p(T0 + i * CADENCE, w));
  }

  /** Detect, allocate, and total exactly what `derived_intervals.energy_kwh` would hold. */
  function runEnergyKwh(signal: SignalSample[]): {
    kwh: number;
    runs: number;
  } {
    const periods = detectRunPeriods(
      signal.map((x) => ({ tMs: x.tMs, value: x.value })),
      evCfg,
    );
    const windows: EnergyWindow[] = periods.map((x) => ({
      startMs: x.startMs,
      endMs: x.endMs,
    }));
    const kwh = energyFromAllocation(
      allocatePowerToWindows(windows, signal, evCfg.nowMs),
    ).reduce<number>((sum, x) => sum + (x ?? 0), 0);
    return { kwh, runs: periods.length };
  }

  /**
   * `energyFromAllocation` rounds each run to 3 dp on the way to the column, so a total of `r` runs
   * can sit up to `r × 0.5 mWh` off the continuous integral. That is the ONLY slack allowed here:
   * anything larger is a boundary disagreement, which is what this suite exists to catch. Half a
   * sample interval — the defect — is 283 mWh, three orders of magnitude outside it.
   */
  function expectAgreement(signal: SignalSample[]) {
    const { kwh, runs } = runEnergyKwh(signal);
    expect(runs).toBeGreaterThan(0);
    expect(Math.abs(kwh - flowMatrixKwh(signal))).toBeLessThanOrEqual(
      runs * 0.0005,
    );
    return kwh;
  }

  it.each([1, 2, 5, 16, 42])(
    "matches on a flat %i-sample session",
    (n: number) => {
      const signal = session(Array<number>(n).fill(6860));
      // And the absolute value is n WHOLE sample intervals, not n − ½ of them — which is the
      // arithmetic the old boundary got wrong, independently of what the flow matrix says.
      expect(expectAgreement(signal)).toBeCloseTo(
        (6.86 * n * CADENCE) / 3_600_000,
        3,
      );
    },
  );

  it("matches when the charger's rate drifts through the session", () => {
    // The real 14 Sep 13:08 session, sample for sample. Stored as 2.573 kWh against a Sankey band
    // of 2.857 — the missing 0.284 is the half interval this test now forbids.
    const signal = session([6860, 6860, 6850, 6870, 6840]);
    expect(expectAgreement(signal)).toBeCloseTo(2.8567, 3);
  });

  it("matches across a dropped poll mid-session", () => {
    // One missing sample inside the run (600 s instead of 300 s). Under delayOff, so it bridges —
    // and both integrations trapezoid the doubled interval identically.
    expectAgreement(
      session(Array<number>(8).fill(6860)).filter((_, i) => i !== 5),
    );
  });

  it("matches across several sessions in one window — the card's footer total", () => {
    // Where the old defect compounded: the debt was per RUN, so the week's total drifted with how
    // often the car was plugged in rather than with how long it charged. Three sessions here; the
    // real week had five, and was 1.4 kWh light.
    const signal = [
      ...session(Array<number>(42).fill(6835), 2, 0),
      ...session(Array<number>(32).fill(6766), 4, 0),
      ...session(Array<number>(5).fill(6856), 4, 4),
    ].map((x, i) => p(T0 + i * CADENCE, x.value));
    const { runs } = runEnergyKwh(signal);
    expect(runs).toBe(3);
    expectAgreement(signal);
  });
});
