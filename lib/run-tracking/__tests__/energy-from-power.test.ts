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
