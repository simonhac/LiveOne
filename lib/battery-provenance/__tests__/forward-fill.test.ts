import { describe, it, expect } from "@jest/globals";
import { forwardFill } from "@/lib/battery-provenance/load";

const MIN = 60 * 1000;
const RATE_FILL_MS = 35 * MIN;
const RATE_NATIVE_MS = 30 * MIN;

// A 1-hour, 5-min-aligned flow timeline: 0,5,10,…,55 min.
const timeline = Array.from({ length: 12 }, (_, i) => i * 5 * MIN);

/** Amber 30-min rate ticks at :00 and :30 with a given quality code. */
function rate30(dq: string) {
  return [
    { t: 0, v: 10, dq },
    { t: 30 * MIN, v: 20, dq },
  ];
}

describe("forwardFill — estimated-flag semantics behind the % estimated chip", () => {
  it("Bug 1+2 fix: a settled (billable 'b') 30-min rate up-sampled to 5-min is NOT estimated", () => {
    const ff = forwardFill(timeline, rate30("b"), RATE_FILL_MS, RATE_NATIVE_MS);
    expect(ff.estimated.every((e) => e === false)).toBe(true);
    expect(ff.value.every((v) => v !== null)).toBe(true);
  });

  it("Bug 2 isolated: without the native-cadence param, up-sampling wrongly flags between-tick slots", () => {
    // Same settled 'b' series, but default nativeIntervalMs (5 min) — the pre-fix behaviour.
    const ff = forwardFill(timeline, rate30("b"), RATE_FILL_MS);
    // Ticks and the 5-min-after slots stay unflagged; the deeper between-tick slots get flagged.
    expect(ff.estimated[0]).toBe(false); // :00 tick
    expect(ff.estimated[2]).toBe(true); // :10 — 10 min stale > 5 min
    expect(ff.estimated.some((e) => e === true)).toBe(true);
  });

  it("Bug 1 isolated: 'b' (billable) is honoured where the literal 'good' check would flag it", () => {
    // At an exact tick (gap 0) filled is false, so the only thing that could flag it is quality.
    const settled = forwardFill(
      timeline,
      rate30("b"),
      RATE_FILL_MS,
      RATE_NATIVE_MS,
    );
    const forecast = forwardFill(
      timeline,
      rate30("f"),
      RATE_FILL_MS,
      RATE_NATIVE_MS,
    );
    expect(settled.estimated[0]).toBe(false); // billable → not estimated
    expect(forecast.estimated[0]).toBe(true); // forecast → estimated
  });

  it("provisional quality (forecast 'f') is estimated on every slot regardless of cadence", () => {
    const ff = forwardFill(timeline, rate30("f"), RATE_FILL_MS, RATE_NATIVE_MS);
    expect(ff.estimated.every((e) => e === true)).toBe(true);
  });

  it("regression: a 5-min-native 'good' series is unchanged (all known)", () => {
    const src = timeline.map((t) => ({ t, v: 1, dq: "good" }));
    const ff = forwardFill(timeline, src, 15 * MIN); // default native = 5 min
    expect(ff.estimated.every((e) => e === false)).toBe(true);
  });

  it("a genuinely missed tick (gap beyond one native interval / maxStale) is still estimated", () => {
    // Next real sample is 60 min later — the :35 slot is a held-too-long fill, :40 exceeds maxStale.
    const src = [
      { t: 0, v: 10, dq: "b" },
      { t: 60 * MIN, v: 20, dq: "b" },
    ];
    const ff = forwardFill(timeline, src, RATE_FILL_MS, RATE_NATIVE_MS);
    expect(ff.estimated[0]).toBe(false); // fresh tick
    expect(ff.estimated[7]).toBe(true); // :35 — 35 min stale > 30 min native
    expect(ff.value[8]).toBeNull(); // :40 — beyond 35 min maxStale
    expect(ff.estimated[8]).toBe(true);
  });
});
