import { describe, it, expect } from "@jest/globals";
import { indexForPosition, indexForSpan, nearestIndexForTime } from "../hooks";

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

describe("indexForSpan", () => {
  // Three uneven buckets, contiguous — a clamped half-June, a whole July, a clamped half-August,
  // which is exactly the shape a trailing Y window produces.
  const span = (from: string, to: string) => ({
    start: new Date(`${from}T00:00:00Z`),
    end: new Date(`${to}T00:00:00Z`),
  });
  const spans = [
    span("2026-06-15", "2026-07-01"),
    span("2026-07-01", "2026-08-01"),
    span("2026-08-01", "2026-08-14"),
  ];
  const ms = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getTime();

  it("returns null for no spans", () => {
    expect(indexForSpan([], ms("2026-07-04"))).toBeNull();
  });

  it("resolves by CONTAINMENT, not by nearest start", () => {
    // 29 July is inside July but closer to August's start than to July's — the whole reason
    // `nearestIndexForTime` is the wrong function for uneven buckets.
    expect(indexForSpan(spans, ms("2026-07-29"))).toBe(1);
    expect(
      nearestIndexForTime(
        spans.map((s) => s.start),
        ms("2026-07-29"),
      ),
    ).toBe(2);
  });

  it("includes a span's start and excludes its end", () => {
    expect(indexForSpan(spans, ms("2026-07-01"))).toBe(1);
    expect(indexForSpan(spans, ms("2026-08-01"))).toBe(2);
    expect(indexForSpan(spans, ms("2026-06-15"))).toBe(0);
  });

  it("clamps outside the window to the nearest end bucket", () => {
    expect(indexForSpan(spans, ms("2026-01-01"))).toBe(0);
    expect(indexForSpan(spans, ms("2026-12-01"))).toBe(2);
  });

  it("picks the closer neighbour across a hole", () => {
    const gapped = [
      span("2026-06-01", "2026-07-01"),
      span("2026-09-01", "2026-10-01"),
    ];
    expect(indexForSpan(gapped, ms("2026-07-10"))).toBe(0);
    expect(indexForSpan(gapped, ms("2026-08-20"))).toBe(1);
  });
});

describe("indexForPosition", () => {
  // 300px / 30 categories = one 10px slice each.
  const W = 300;
  const N = 30;

  it("puts a pixel in the slice that contains it", () => {
    expect(indexForPosition(0, W, N)).toBe(0);
    expect(indexForPosition(9.9, W, N)).toBe(0);
    expect(indexForPosition(10, W, N)).toBe(1);
    expect(indexForPosition(155, W, N)).toBe(15);
    expect(indexForPosition(299, W, N)).toBe(29);
  });

  it("clamps outside the plot rather than reporting a missing category", () => {
    // The pointer reaches the margins (the svg is the hit target, not the plot box), and a reader
    // dragging off the right edge should keep the last bar, not lose the crosshair.
    expect(indexForPosition(-40, W, N)).toBe(0);
    expect(indexForPosition(W, W, N)).toBe(N - 1);
    expect(indexForPosition(W + 40, W, N)).toBe(N - 1);
  });

  it("returns null for a degenerate plot", () => {
    expect(indexForPosition(10, 0, N)).toBeNull();
    expect(indexForPosition(10, W, 0)).toBeNull();
  });

  it("disagrees with nearest-timestamp exactly where the M bug was", () => {
    // A 30-bar window whose SCALE spans 30.5 buckets — the partial bucket an M window carries. The
    // scale therefore compresses each bucket to 300/30.5 px while the bars are drawn 10px wide, so
    // by the last bar the two readings are a whole category apart.
    const step = 3600_000;
    const t0 = Date.UTC(2026, 5, 1);
    const stamps = Array.from({ length: N }, (_, i) => new Date(t0 + i * step));
    const msPerPx = ((N + 0.5) * step) / W;
    const px = 195; // dead centre of the 20th bar, which spans 190–200px
    expect(indexForPosition(px, W, N)).toBe(19);
    // The scale reads the same pixel as 19.8 buckets in and hands back the NEXT bar.
    expect(nearestIndexForTime(stamps, t0 + px * msPerPx)).toBe(20);
  });
});
