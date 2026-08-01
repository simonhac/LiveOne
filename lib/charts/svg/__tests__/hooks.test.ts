import { describe, it, expect } from "@jest/globals";
import { nearestIndexForTime } from "../hooks";

/**
 * Only the pure half is covered here. The hooks themselves need a DOM and this repo has no jsdom or
 * testing-library (see the plan's "no visual test net" note) — their behaviour is covered by the
 * screenshot harness and by manual hover checks instead.
 */

const ts = Array.from(
  { length: 5 },
  (_, i) => new Date(2026, 5, 15, 0, i * 30),
);
const at = (i: number) => ts[i].getTime();

describe("nearestIndexForTime", () => {
  it("finds an exact hit", () => {
    for (let i = 0; i < ts.length; i++) {
      expect(nearestIndexForTime(ts, at(i))).toBe(i);
    }
  });

  it("rounds to the closer neighbour", () => {
    expect(nearestIndexForTime(ts, at(1) + 10 * 60_000)).toBe(1); // 10 min past → still 1
    expect(nearestIndexForTime(ts, at(1) + 20 * 60_000)).toBe(2); // 20 min past → nearer 2
  });

  it("clamps outside the range instead of returning null", () => {
    // A pointer just off the plot edge should still focus the end point, not clear the selection.
    expect(nearestIndexForTime(ts, at(0) - 60 * 60_000)).toBe(0);
    expect(nearestIndexForTime(ts, at(4) + 60 * 60_000)).toBe(4);
  });

  it("returns null only for an empty series", () => {
    expect(nearestIndexForTime([], Date.now())).toBeNull();
  });

  it("handles a single point", () => {
    expect(nearestIndexForTime([ts[0]], at(0) + 5_000)).toBe(0);
  });

  it("agrees with a linear scan over a realistic series", () => {
    // The binary search must not disagree with the obvious implementation — this is the same result
    // `nearestIndex` in ChartFocusContext produces, just without the O(n) sweep on every mousemove.
    const many = Array.from(
      { length: 289 },
      (_, i) => new Date(2026, 5, 15, 0, i * 5),
    );
    const linear = (target: number) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < many.length; i++) {
        const d = Math.abs(many[i].getTime() - target);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    };
    for (const probe of [0, 1, 137, 288]) {
      for (const nudge of [-120_000, -1, 0, 1, 120_000]) {
        const t = many[probe].getTime() + nudge;
        expect(nearestIndexForTime(many, t)).toBe(linear(t));
      }
    }
  });
});
