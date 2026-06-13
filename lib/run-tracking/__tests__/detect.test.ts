import { describe, it, expect } from "@jest/globals";
import {
  detectRunPeriods,
  type Sample,
  type DetectConfig,
} from "@/lib/run-tracking/detect";

const T0 = 1_700_000_000_000; // fixed arbitrary epoch-ms
const MIN = 60_000;
const FAR_FUTURE = T0 + 10_000_000; // well past delayOff so tails close

function s(tMs: number, value: number | null): Sample {
  return { tMs, value };
}

/** Generator-like defaults: on when grid power < -50W, 120s coalescing, no hysteresis/min-run. */
function cfg(overrides: Partial<DetectConfig> = {}): DetectConfig {
  return {
    lowerW: -50,
    upperW: null,
    hysteresisW: 0,
    delayOnMs: 0,
    delayOffMs: 120_000,
    nowMs: FAR_FUTURE,
    boundaryMode: "edge",
    ...overrides,
  };
}

describe("detectRunPeriods", () => {
  it("coalesces a sustained run into one closed period with metrics", () => {
    const samples = [
      s(T0, -1000),
      s(T0 + MIN, -1200),
      s(T0 + 2 * MIN, -800),
      s(T0 + 3 * MIN, -1000),
    ];
    const periods = detectRunPeriods(samples, cfg());
    expect(periods).toHaveLength(1);
    expect(periods[0].startMs).toBe(T0);
    expect(periods[0].endMs).toBe(T0 + 3 * MIN);
    expect(periods[0].sampleCount).toBe(4);
    expect(periods[0].minW).toBe(-1200);
    expect(periods[0].maxW).toBe(-800);
    expect(periods[0].avgW).toBe((-1000 - 1200 - 800 - 1000) / 4);
    expect(periods[0].closeReason).toBe("gap");
  });

  it("bridges a gap exactly at delayOff (one run) but breaks just past it (two runs)", () => {
    const bridged = detectRunPeriods(
      [s(T0, -1000), s(T0 + 120_000, -1000)],
      cfg(),
    );
    expect(bridged).toHaveLength(1);
    expect(bridged[0].sampleCount).toBe(2);

    const broken = detectRunPeriods(
      [s(T0, -1000), s(T0 + 120_001, -1000)],
      cfg(),
    );
    expect(broken).toHaveLength(2);
    expect(broken[0].endMs).toBe(T0); // first run closes at its last on-sample
    expect(broken[1].startMs).toBe(T0 + 120_001);
  });

  it("bridges a brief off-sample within delayOff", () => {
    const samples = [
      s(T0, -1000),
      s(T0 + MIN, 500), // off (grid exporting), within delayOff
      s(T0 + 2 * MIN, -1000),
    ];
    const periods = detectRunPeriods(samples, cfg());
    expect(periods).toHaveLength(1);
    expect(periods[0].startMs).toBe(T0);
    expect(periods[0].endMs).toBe(T0 + 2 * MIN);
    expect(periods[0].sampleCount).toBe(2); // off sample not counted in metrics
  });

  it("leaves the final run open when its last on-sample is within delayOff of now", () => {
    const now = T0 + 5 * MIN;
    const samples = [s(T0 + 3 * MIN, -1000), s(T0 + 4 * MIN, -1000)];
    const periods = detectRunPeriods(samples, cfg({ nowMs: now }));
    expect(periods).toHaveLength(1);
    expect(periods[0].endMs).toBeNull();
  });

  it("closes the final run (staleness) when the last on-sample is older than delayOff", () => {
    const samples = [s(T0, -1000), s(T0 + MIN, -1000)];
    const periods = detectRunPeriods(samples, cfg({ nowMs: FAR_FUTURE }));
    expect(periods).toHaveLength(1);
    expect(periods[0].endMs).toBe(T0 + MIN);
    expect(periods[0].closeReason).toBe("gap");
  });

  it("drops closed runs shorter than delayOn but keeps the open one", () => {
    // A lone spike (duration 0) is dropped when delayOn > 0.
    const spike = detectRunPeriods([s(T0, -1000)], cfg({ delayOnMs: MIN }));
    expect(spike).toHaveLength(0);

    // A run spanning >= delayOn is kept.
    const kept = detectRunPeriods(
      [s(T0, -1000), s(T0 + MIN, -1000)],
      cfg({ delayOnMs: MIN }),
    );
    expect(kept).toHaveLength(1);

    // The open run is exempt from the min-run filter.
    const now = T0 + 30_000;
    const open = detectRunPeriods(
      [s(T0, -1000)],
      cfg({ delayOnMs: MIN, nowMs: now }),
    );
    expect(open).toHaveLength(1);
    expect(open[0].endMs).toBeNull();
  });

  it("treats a value exactly at the threshold as not-on (hold) when hysteresis is 0", () => {
    expect(detectRunPeriods([s(T0, -50)], cfg())).toHaveLength(0);
    expect(detectRunPeriods([s(T0, -50.0001)], cfg())).toHaveLength(1);
  });

  it("applies a hysteresis deadband to classification", () => {
    // lower -50, hysteresis 20 → on below -70, off above -30, hold in between.
    const h = cfg({ hysteresisW: 20, nowMs: FAR_FUTURE });
    // A first sample inside the deadband (prev state off) does not start a run.
    expect(detectRunPeriods([s(T0, -55)], h)).toHaveLength(0);
    // Once clearly on, a deadband sample holds the run.
    const periods = detectRunPeriods(
      [s(T0, -100), s(T0 + MIN, -55), s(T0 + 2 * MIN, -10)],
      h,
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].endMs).toBe(T0 + MIN); // held through -55, ended (off) at -10
    expect(periods[0].sampleCount).toBe(2);
  });

  it("bridges short null gaps but closes on a long null gap", () => {
    const bridged = detectRunPeriods(
      [s(T0, -1000), s(T0 + MIN, null), s(T0 + 2 * MIN, -1000)],
      cfg(),
    );
    expect(bridged).toHaveLength(1);

    const broken = detectRunPeriods(
      [s(T0, -1000), s(T0 + 3 * MIN, null), s(T0 + 6 * MIN, -1000)],
      cfg(),
    );
    expect(broken).toHaveLength(2);
  });

  it("places the start at the midpoint of the crossing interval in midpoint mode", () => {
    const samples = [
      s(T0, 0), // off
      s(T0 + 2 * MIN, -1000), // first on
      s(T0 + 3 * MIN, -1000),
    ];
    const periods = detectRunPeriods(
      samples,
      cfg({ boundaryMode: "midpoint" }),
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].startMs).toBe(T0 + MIN); // midpoint of T0 and T0+2min
  });

  it("is deterministic regardless of input order", () => {
    const ordered = [
      s(T0, -1000),
      s(T0 + MIN, -1000),
      s(T0 + 5 * MIN, -1000),
      s(T0 + 6 * MIN, -1000),
    ];
    const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
    expect(detectRunPeriods(shuffled, cfg())).toEqual(
      detectRunPeriods(ordered, cfg()),
    );
  });

  it("returns [] for empty input", () => {
    expect(detectRunPeriods([], cfg())).toEqual([]);
  });

  it("supports an upper-bound device (on when above)", () => {
    const c = cfg({ lowerW: null, upperW: 100 });
    const periods = detectRunPeriods(
      [s(T0, 50), s(T0 + MIN, 500), s(T0 + 2 * MIN, 600)],
      c,
    );
    expect(periods).toHaveLength(1);
    expect(periods[0].startMs).toBe(T0 + MIN);
    expect(periods[0].maxW).toBe(600);
  });

  it("throws when neither bound is configured", () => {
    expect(() =>
      detectRunPeriods([s(T0, -1000)], cfg({ lowerW: null, upperW: null })),
    ).toThrow();
  });
});
