import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_ADVISOR_CONFIG,
  INITIAL_ADVISOR_STATE,
  stepAdvisor,
  type Advice,
  type AdvisorConfig,
  type LiveSample,
} from "../advisor";
import { aest, flatProfile, LINEAR_BATTERY, TZ } from "./fixtures";

const STEP = 300_000;

interface Shape {
  solarW: (ms: number) => number;
  evW: (ms: number) => number;
  batteryW?: (ms: number) => number;
}

function run(
  from: number,
  to: number,
  shape: Shape,
  config: Partial<AdvisorConfig> = {},
): Advice[] {
  const ctx = {
    config: { ...DEFAULT_ADVISOR_CONFIG, tz: TZ, ...config },
    battery: LINEAR_BATTERY,
    profileFor: () => flatProfile(),
  };
  let state = INITIAL_ADVISOR_STATE;
  const out: Advice[] = [];
  for (let t = from; t <= to; t += STEP) {
    const s: LiveSample = {
      t,
      soc: 90,
      solarW: shape.solarW(t),
      evW: shape.evW(t),
      batteryW: shape.batteryW?.(t) ?? 0,
    };
    const r = stepAdvisor(state, s, ctx);
    state = r.state;
    if (r.advice) out.push(r.advice);
  }
  return out;
}

const D = "2026-07-01";
const between = (a: number, b: number, w: number) => (ms: number) =>
  ms >= a && ms < b ? w : 0;
/** Sunny until 17:00, dark after. */
const dusk = (ms: number) => (ms < aest(D, 17) ? 3000 : 0);

const SUN_DOWN = { trigger: "sun-down" as const };

describe("stepAdvisor — sun-down trigger", () => {
  it("advises once, on the second charging sample after the sun is down", () => {
    const advices = run(
      aest(D, 12),
      aest("2026-07-02", 6),
      { solarW: dusk, evW: between(aest(D, 19), aest(D, 23), 7000) },
      SUN_DOWN,
    );
    expect(advices).toHaveLength(1);
    expect(advices[0].atMs).toBe(aest(D, 19, 5));
    expect(advices[0].night).toBe(D);
    // First charging sample opens the session; the second integrates 7 kW × 5 min.
    expect(advices[0].sessionKwhSoFar).toBeCloseTo((7 * 5) / 60, 6);
    expect(advices[0].solution.kind).toBe("stop-at");
  });

  it("holds sun-down through a blip between the thresholds, and drops it above the exit", () => {
    const ev = between(aest(D, 19), aest(D, 23), 7000);
    const blip = (w: number) => (ms: number) =>
      ms === aest(D, 19) ? w : dusk(ms);
    expect(
      run(aest(D, 12), aest(D, 23), { solarW: blip(300), evW: ev }, SUN_DOWN)[0]
        .atMs,
    ).toBe(aest(D, 19, 5));
    // 500 W > exit: sun-down must re-enter over three fresh samples (19:05, :10, :15).
    expect(
      run(aest(D, 12), aest(D, 23), { solarW: blip(500), evW: ev }, SUN_DOWN)[0]
        .atMs,
    ).toBe(aest(D, 19, 15));
  });

  it("ignores a dark midday (outside the evening window)", () => {
    const advices = run(
      aest(D, 12),
      aest(D, 14, 55),
      {
        solarW: () => 0,
        evW: between(aest(D, 12), aest(D, 15), 7000),
        batteryW: between(aest(D, 12), aest(D, 15), 7300),
      },
      SUN_DOWN,
    );
    expect(advices).toHaveLength(0);
    // Nor does the default trigger, with the battery plainly feeding the car.
    expect(
      run(aest(D, 12), aest(D, 14, 55), {
        solarW: () => 0,
        evW: between(aest(D, 12), aest(D, 15), 7000),
        batteryW: between(aest(D, 12), aest(D, 15), 7300),
      }),
    ).toHaveLength(0);
  });

  it("advises a second session the same night, but not the same session twice", () => {
    const ev = (ms: number) =>
      (ms >= aest(D, 19) && ms < aest(D, 20)) ||
      (ms >= aest(D, 21) && ms < aest(D, 22))
        ? 7000
        : 0;
    const advices = run(
      aest(D, 12),
      aest("2026-07-02", 6),
      { solarW: dusk, evW: ev },
      SUN_DOWN,
    );
    expect(advices.map((a) => a.atMs)).toEqual([
      aest(D, 19, 5),
      aest(D, 21, 5),
    ]);
  });
});

describe("stepAdvisor — battery-feeding-car trigger (the default)", () => {
  it("fires while the sun is still up once the battery is feeding the car", () => {
    const shape: Shape = {
      solarW: () => 2000,
      evW: between(aest(D, 16), aest(D, 20), 7000),
      batteryW: between(aest(D, 16), aest(D, 20), 5300),
    };
    expect(run(aest(D, 12), aest(D, 20), shape).map((a) => a.atMs)).toEqual([
      aest(D, 16, 5),
    ]);
    // 2 kW of sun never reads as sun-down.
    expect(run(aest(D, 12), aest(D, 20), shape, SUN_DOWN)).toHaveLength(0);
  });

  it("does not fire when solar covers the car", () => {
    const advices = run(aest(D, 12), aest(D, 20), {
      solarW: () => 8000,
      evW: between(aest(D, 16), aest(D, 20), 7000),
      batteryW: () => -700,
    });
    expect(advices).toHaveLength(0);
  });
});
