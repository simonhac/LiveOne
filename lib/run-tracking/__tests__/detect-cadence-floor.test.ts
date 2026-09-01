/**
 * The cadence floor under `delayOffMs` — the fix for a units bug.
 *
 * `delayOffMs` is compared against `s.tMs - run.lastOnMs`, a SAMPLE GAP, so a threshold on it is
 * only meaningful in multiples of the sampling interval. It is configured in absolute seconds. The
 * `ev` role default of 300 s was sized against Kinkora Mondo (120 s median cadence — 2.5x, roomy);
 * pointed at the Sigenergy charger, which polls every ~300 s, the same number is 1.0x, and one
 * six-hour charge was detected as 25 runs of 3-8 minutes.
 *
 * The floor is `max(policy, k × observed on-sample cadence)`, so it can only ever MERGE more — it
 * cannot fragment a detector that works today. These pin that, and pin the two ways it stays out of
 * the way.
 */
import { describe, it, expect } from "@jest/globals";
import {
  detectRunPeriods,
  effectiveDelayOffMs,
  medianOnSampleIntervalMs,
  DEFAULT_DELAY_OFF_CADENCE_MULTIPLE,
  type DetectConfig,
  type Sample,
} from "@/lib/run-tracking/detect";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const FAR_FUTURE = T0 + 10_000_000;

const s = (tMs: number, value: number | null): Sample => ({ tMs, value });

/** EV-shaped: on above 100 W, the `ev` role's 300 s merge policy. */
function ev(overrides: Partial<DetectConfig> = {}): DetectConfig {
  return {
    lowerW: null,
    upperW: 100,
    hysteresisW: 0,
    delayOnMs: 0,
    delayOffMs: 300 * SEC,
    nowMs: FAR_FUTURE,
    boundaryMode: "midpoint",
    ...overrides,
  };
}

/** A charge held at 6.8 kW, sampled every `cadenceSec`, for `minutes`. */
function charge(cadenceSec: number, minutes: number): Sample[] {
  const step = cadenceSec * SEC;
  const n = Math.floor((minutes * 60) / cadenceSec) + 1;
  return Array.from({ length: n }, (_, i) => s(T0 + i * step, 6800));
}

describe("medianOnSampleIntervalMs", () => {
  it("measures the rhythm of the ON samples", () => {
    expect(medianOnSampleIntervalMs(charge(300, 60), ev())).toBe(300 * SEC);
  });

  it("is null until the window has shown a rhythm", () => {
    // Three on-samples give two intervals — noise, not a cadence.
    expect(medianOnSampleIntervalMs(charge(300, 10), ev())).toBe(null);
    expect(medianOnSampleIntervalMs([], ev())).toBe(null);
  });

  it("ignores idle cadence entirely — the Daylesford generator case", () => {
    // 🛑 The reason this measures ON samples rather than all samples. DeepSea polls at 300 s idle
    // and 60 s while the engine runs. A median over EVERY sample would report ~300 s here and floor
    // delayOff at 900 s, bridging fifteen-minute gaps and merging separate generator runs.
    const idleBefore = Array.from({ length: 20 }, (_, i) =>
      s(T0 + i * 300 * SEC, 0),
    );
    const running = Array.from({ length: 20 }, (_, i) =>
      s(T0 + 20 * 300 * SEC + i * 60 * SEC, 1500),
    );
    expect(medianOnSampleIntervalMs([...idleBefore, ...running], ev())).toBe(
      60 * SEC,
    );
  });
});

describe("effectiveDelayOffMs", () => {
  it("raises the Kutis case to 3x its 300 s cadence", () => {
    expect(effectiveDelayOffMs(charge(300, 120), ev())).toBe(
      300 * SEC * DEFAULT_DELAY_OFF_CADENCE_MULTIPLE,
    );
  });

  it("never LOWERS the configured policy", () => {
    // Kinkora's cadence is 120 s; 3x is 360 s, above its 300 s policy, so it rises. But a policy
    // already above the floor is left alone — this is a max, not an assignment.
    expect(effectiveDelayOffMs(charge(120, 120), ev())).toBe(360 * SEC);
    expect(
      effectiveDelayOffMs(charge(60, 120), ev({ delayOffMs: 900 * SEC })),
    ).toBe(900 * SEC);
  });

  it("stands aside when disabled, or when the cadence is unknown", () => {
    expect(
      effectiveDelayOffMs(charge(300, 120), ev({ delayOffCadenceMultiple: 0 })),
    ).toBe(300 * SEC);
    expect(effectiveDelayOffMs(charge(300, 10), ev())).toBe(300 * SEC);
  });
});

describe("detectRunPeriods with the floor", () => {
  /** The real shape: 5-minute polling with the jitter that actually broke it. */
  function jittered(minutes: number): Sample[] {
    const out: Sample[] = [];
    let t = T0;
    for (let i = 0; i * 5 < minutes; i++) {
      out.push(s(t, 6800));
      // Alternate 300 s and 330 s — 31 of 74 measured gaps exceeded 300 s.
      t += (i % 2 === 0 ? 330 : 300) * SEC;
    }
    return out;
  }

  it("detects one charge where the unfloored config finds many", () => {
    const samples = jittered(360);

    const fragmented = detectRunPeriods(
      samples,
      ev({ delayOffCadenceMultiple: 0 }),
    );
    expect(fragmented.length).toBeGreaterThan(10);

    const whole = detectRunPeriods(samples, ev());
    expect(whole).toHaveLength(1);
    expect(whole[0].sampleCount).toBe(samples.length);
  });

  it("still separates charges that are genuinely apart", () => {
    // Two 60-minute charges either side of a four-hour gap. The floor merges poll gaps, not days.
    const first = charge(300, 60);
    const second = charge(300, 60).map((x) =>
      s(x.tMs + 5 * 60 * 60 * SEC, x.value),
    );
    expect(detectRunPeriods([...first, ...second], ev())).toHaveLength(2);
  });

  it("leaves a detector whose policy already exceeds the floor untouched", () => {
    // Daylesford's generator: 60 s active cadence, 240 s policy. 3x60 = 180 < 240, so nothing moves.
    const running = Array.from({ length: 30 }, (_, i) =>
      s(T0 + i * 60 * SEC, 1500),
    );
    const cfg = ev({ delayOffMs: 240 * SEC, upperW: 500 });
    expect(effectiveDelayOffMs(running, cfg)).toBe(240 * SEC);
    expect(detectRunPeriods(running, cfg)).toEqual(
      detectRunPeriods(running, { ...cfg, delayOffCadenceMultiple: 0 }),
    );
  });
});
