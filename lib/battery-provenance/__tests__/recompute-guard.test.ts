import { describe, it, expect } from "@jest/globals";
import { lastCompletableIntervalMs } from "../recompute";

const FIVE = 5 * 60 * 1000;

/**
 * The `blendIsCurrent` skip-guard clamp. The receiver writes the IN-PROGRESS 5m bucket (and its
 * successor), so the raw input watermark runs ahead of anything a fold windowed to `now` can
 * cover — comparing the blend against the raw watermark unclamped made the guard dead code and the
 * whole-day refold ran every minute. These pin the boundary math the fix rests on.
 */
describe("lastCompletableIntervalMs", () => {
  const T0 = Date.UTC(2026, 5, 1, 10, 0); // 10:00:00, a 5m boundary

  it("mid-interval: the last complete boundary is behind now", () => {
    expect(lastCompletableIntervalMs(T0 + 90_000)).toBe(T0); // 10:01:30 → 10:00
    expect(lastCompletableIntervalMs(T0 + FIVE - 1)).toBe(T0); // 10:04:59.999 → 10:00
  });

  it("exactly on a boundary: that interval just completed and is coverable", () => {
    expect(lastCompletableIntervalMs(T0 + FIVE)).toBe(T0 + FIVE);
  });

  it("guard truth table: in-progress bucket no longer defeats the skip", () => {
    // At 10:01:30 the receiver has already written input rows for interval-end 10:05 (the
    // in-progress bucket) and 10:10 (its successor); the blend can have reached 10:00 at most.
    const now = T0 + 90_000;
    const inMax = T0 + 2 * FIVE; // raw watermark: successor bucket
    const outMax = T0; // blend covers everything coverable
    // Unclamped comparison (the old guard): never current while the feed is live.
    expect(outMax >= inMax).toBe(false);
    // Clamped: current — nothing new is foldable until the 10:05 boundary passes.
    expect(outMax >= Math.min(inMax, lastCompletableIntervalMs(now))).toBe(
      true,
    );
    // ...and once it does, the guard correctly demands a refold again.
    const afterBoundary = T0 + FIVE + 30_000; // 10:05:30
    expect(
      outMax >= Math.min(inMax, lastCompletableIntervalMs(afterBoundary)),
    ).toBe(false);
  });

  it("a genuinely lagging blend is still stale regardless of the clamp", () => {
    const now = T0 + 90_000;
    const inMax = T0; // input reached 10:00
    const outMax = T0 - FIVE; // blend stuck at 09:55
    expect(outMax >= Math.min(inMax, lastCompletableIntervalMs(now))).toBe(
      false,
    );
  });
});
