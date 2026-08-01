import { describe, it, expect } from "@jest/globals";
import { scaleLinear, scaleTime } from "d3-scale";
import { bandPath, definedSegments, linePath, stackedBands } from "../paths";

const ts = Array.from(
  { length: 6 },
  (_, i) => new Date(2026, 5, 15, 0, i * 30),
);
const x = scaleTime()
  .domain([ts[0], ts[ts.length - 1]])
  .range([0, 100]);
const y = scaleLinear().domain([0, 10]).range([50, 0]);

/** How many separate sub-paths a `d` contains — one `M` per contiguous run. */
const subPaths = (d: string | null) => (d ? d.split("M").length - 1 : 0);

describe("definedSegments", () => {
  it("finds one run when nothing is missing", () => {
    expect(definedSegments([1, 2, 3])).toEqual([[0, 2]]);
  });

  it("splits on a hole and resumes after it", () => {
    expect(definedSegments([1, null, 3, 4])).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });

  it("handles holes at both ends", () => {
    expect(definedSegments([null, 2, 3, null])).toEqual([[1, 2]]);
  });

  it("treats NaN and Infinity as holes, not values", () => {
    // convertToKw can only emit numbers or null, but a fixture bug once put NaN here and it silently
    // rendered as a real point — see the gap-fixture note in the plan.
    expect(definedSegments([1, NaN, 3])).toEqual([
      [0, 0],
      [2, 2],
    ]);
    expect(definedSegments([1, Infinity, 3])).toHaveLength(2);
  });

  it("returns nothing for an all-null series", () => {
    expect(definedSegments([null, null])).toEqual([]);
  });
});

describe("linePath", () => {
  it("draws one sub-path for a complete series", () => {
    const d = linePath(ts, [1, 2, 3, 4, 5, 6], x, y);
    expect(d).not.toBeNull();
    expect(subPaths(d)).toBe(1);
  });

  it("BREAKS at a null rather than bridging it", () => {
    // The whole point of spanGaps: false — a bridged line asserts data that does not exist.
    const d = linePath(ts, [1, 2, null, 4, 5, 6], x, y);
    expect(subPaths(d)).toBe(2);
  });

  it("breaks once per hole", () => {
    expect(subPaths(linePath(ts, [1, null, 3, null, 5, 6], x, y))).toBe(3);
  });

  it("returns null when there is nothing to draw", () => {
    expect(linePath(ts, [null, null, null, null, null, null], x, y)).toBeNull();
    expect(linePath([], [], x, y)).toBeNull();
  });

  it("places points via the supplied scales", () => {
    const d = linePath([ts[0], ts[5]], [0, 10], x, y)!;
    // First point at x=0 (domain start) and y=50 (domain min, inverted).
    expect(d).toMatch(/^M0,50/);
  });
});

describe("bandPath", () => {
  it("draws a filled band between the two bounds", () => {
    const d = bandPath(ts, [1, 1, 1, 1, 1, 1], [5, 5, 5, 5, 5, 5], x, y);
    expect(d).not.toBeNull();
    expect(subPaths(d)).toBe(1);
  });

  it("breaks where EITHER bound is missing", () => {
    // Half a band is worse than none — it reads as a real value.
    expect(
      subPaths(bandPath(ts, [1, null, 1, 1, 1, 1], [5, 5, 5, 5, 5, 5], x, y)),
    ).toBe(2);
    expect(
      subPaths(bandPath(ts, [1, 1, 1, 1, 1, 1], [5, null, 5, 5, 5, 5], x, y)),
    ).toBe(2);
  });

  it("returns null when the band is entirely missing", () => {
    expect(bandPath(ts, [null, null], [null, null], x, y)).toBeNull();
  });
});

describe("stackedBands", () => {
  const a = { key: "a", values: [1, 1, 1, 1, 1, 1] };
  const b = { key: "b", values: [2, 2, 2, 2, 2, 2] };

  it("returns one band per series, in the given order", () => {
    const bands = stackedBands(ts, [a, b], x, y);
    expect(bands.map((s) => s.key)).toEqual(["a", "b"]);
  });

  it("stacks b on top of a rather than overlaying it", () => {
    const [bandA, bandB] = stackedBands(ts, [a, b], x, y);
    // a occupies 0..1 and b occupies 1..3 in data space. y is inverted, so b must reach a SMALLER
    // pixel value than a. Parse `x,y` pairs and compare the topmost y of each — matching bare
    // numbers would pick up x coordinates too.
    const topOf = (d: string) =>
      Math.min(
        ...[...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2])),
      );
    expect(topOf(bandB.d!)).toBeLessThan(topOf(bandA.d!));
    // And concretely: with domain [0,10] → range [50,0], a spans y 45..50 and b spans y 35..45.
    expect(topOf(bandA.d!)).toBeCloseTo(45, 6);
    expect(topOf(bandB.d!)).toBeCloseTo(35, 6);
  });

  /**
   * 🛑 The decision this module exists to pin. A null in ANY series breaks the whole column, rather
   * than being treated as zero — otherwise a sensor outage slides every band above it downward and
   * renders as a genuine trough.
   */
  it("punches a hole through EVERY band when one series is null", () => {
    const holed = { key: "b", values: [2, 2, null, 2, 2, 2] };
    const bands = stackedBands(ts, [a, holed], x, y);
    for (const band of bands) expect(subPaths(band.d)).toBe(2);
  });

  it("does not treat the hole as zero", () => {
    const holed = { key: "b", values: [2, 2, null, 2, 2, 2] };
    const withHole = stackedBands(ts, [a, holed], x, y);
    const asZero = stackedBands(
      ts,
      [a, { key: "b", values: [2, 2, 0, 2, 2, 2] }],
      x,
      y,
    );
    // The zero version is continuous; the null version is not. If these ever match, the null is
    // being silently invented as a reading.
    expect(subPaths(asZero[1].d)).toBe(1);
    expect(subPaths(withHole[1].d)).toBe(2);
  });

  it("handles no series and all-null series without throwing", () => {
    expect(stackedBands(ts, [], x, y)).toEqual([]);
    const empty = stackedBands(
      ts,
      [{ key: "a", values: [null, null, null, null, null, null] }],
      x,
      y,
    );
    expect(empty[0].d).toBeNull();
  });
});

describe("step-after interpolation", () => {
  /**
   * A value that HOLDS for an interval — a per-minute count, a reserve floor that changes once a day
   * — must not be drawn as a slope, which asserts readings that were never taken.
   */
  it("linePath emits horizontal-then-vertical rather than a diagonal", () => {
    const two = [ts[0], ts[1]];
    const linear = linePath(two, [0, 10], x, y, "linear")!;
    const stepped = linePath(two, [0, 10], x, y, "stepAfter")!;
    expect(stepped).not.toBe(linear);
    // The step introduces an intermediate vertex; the straight line has exactly two.
    const verts = (d: string) =>
      [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].length;
    expect(verts(stepped)).toBeGreaterThan(verts(linear));
  });

  it("still breaks at nulls when stepped", () => {
    const d = linePath(ts, [1, 2, null, 4, 5, 6], x, y, "stepAfter");
    expect(subPaths(d)).toBe(2);
  });

  it("stackedBands accepts the same curve and keeps its hole semantics", () => {
    const a2 = { key: "a", values: [1, 1, null, 1, 1, 1] };
    const bands = stackedBands(ts, [a2], x, y, "stepAfter");
    expect(subPaths(bands[0].d)).toBe(2);
  });
});

describe("stackedBands — fill and stroke are separate paths", () => {
  const a = { key: "a", values: [1, 1, 1, 1, 1, 1] };

  /**
   * The bug this exists to stop. `area()` emits a CLOSED path, so stroking it draws the baseline and
   * the vertical end caps as well as the top edge — on the real dashboard that put a hard line along
   * y=0 for the whole width of a Grid Export series, which Chart.js never drew.
   */
  it("the fill path is closed and the top path is not", () => {
    const [band] = stackedBands(ts, [a], x, y);
    expect(band.d).toMatch(/Z$/); // closed — fill only
    expect(band.topD).not.toMatch(/Z/); // open — safe to stroke
  });

  it("the top path traces the band's upper edge, never the baseline", () => {
    // Band spans 0..1 in data space; y maps 0→50 and 1→45. The stroke must only touch 45.
    const [band] = stackedBands(ts, [a], x, y);
    const ys = [...band.topD!.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) =>
      Number(m[2]),
    );
    expect(new Set(ys)).toEqual(new Set([45]));
    expect(ys).not.toContain(50); // 50 is the baseline
  });

  it("a series sitting at zero strokes only its own line, not a doubled baseline", () => {
    const zero = { key: "z", values: [0, 0, 0, 0, 0, 0] };
    const [band] = stackedBands(ts, [zero], x, y);
    const ys = [...band.topD!.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) =>
      Number(m[2]),
    );
    // One line at y(0), which is what Chart.js drew for an all-zero dataset — not two.
    expect(new Set(ys)).toEqual(new Set([50]));
  });

  it("the stroke breaks wherever the fill does", () => {
    const holed = { key: "b", values: [2, 2, null, 2, 2, 2] };
    const [band] = stackedBands(ts, [a, holed], x, y).slice(1);
    expect(subPaths(band.d)).toBe(2);
    expect(subPaths(band.topD)).toBe(2);
  });
});
