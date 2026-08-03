import { describe, it, expect } from "@jest/globals";
import { sparklineGeometry } from "@/lib/charts/sparkline";

const W = 100;
const H = 24;

/** Right-most x across every segment — "how far along the window does the line claim to reach?". */
function rightEdge(segments: string[]): number {
  const xs = segments.flatMap((s) =>
    s.split(" ").map((pt) => Number(pt.split(",")[0])),
  );
  return Math.max(...xs);
}

describe("sparklineGeometry", () => {
  it("spreads a complete series across the full width", () => {
    const { segments, drawable } = sparklineGeometry([1, 2, 3, 4, 5], W, H);
    expect(segments).toHaveLength(1);
    expect(drawable).toBe(5);
    expect(rightEdge(segments)).toBeCloseTo(W);
  });

  it("scales y to the value range, largest value at the top", () => {
    const { segments, domain } = sparklineGeometry([10, 20], W, H);
    expect(domain).toEqual({ min: 10, max: 20 });
    expect(segments[0]).toBe(`0.00,${H.toFixed(2)} ${W.toFixed(2)},0.00`);
  });

  it("pins a flat series to the bottom instead of dividing by zero", () => {
    const { segments } = sparklineGeometry([7, 7, 7], W, H);
    expect(segments).toHaveLength(1);
    expect(
      segments[0].split(" ").every((p) => p.endsWith(`,${H.toFixed(2)}`)),
    ).toBe(true);
  });

  // The regression this module exists for: a dense window whose newest intervals have not been
  // produced yet must NOT reach the right-hand edge. Compacting the nulls away used to stretch the
  // remaining points across the full width, so a 1.6h-old tail rendered as up-to-the-minute.
  it("stops short when the tail is null, rather than stretching to the edge", () => {
    const values = [1, 2, 3, 4, 5, null, null, null, null, null];
    const { segments, drawable } = sparklineGeometry(values, W, H);
    expect(drawable).toBe(5);
    // Last drawable point is index 4 of 9 → 44.44% along, not 100%.
    expect(rightEdge(segments)).toBeCloseTo((4 / 9) * W);
    expect(rightEdge(segments)).toBeLessThan(W);
  });

  it("breaks the line at an interior gap rather than bridging it", () => {
    const { segments } = sparklineGeometry([1, 2, null, 4, 5], W, H);
    expect(segments).toHaveLength(2);
    expect(segments[0].split(" ")).toHaveLength(2);
    expect(segments[1].split(" ")).toHaveLength(2);
  });

  it("starts at the first drawable point when the head is null", () => {
    const { segments } = sparklineGeometry([null, null, 3, 4, 5], W, H);
    expect(segments).toHaveLength(1);
    expect(Number(segments[0].split(" ")[0].split(",")[0])).toBeCloseTo(
      (2 / 4) * W,
    );
  });

  it("treats non-finite and non-numeric slots as gaps", () => {
    const values = [1, NaN, 3, undefined, 5] as (number | null | undefined)[];
    const { segments, drawable } = sparklineGeometry(values, W, H);
    expect(drawable).toBe(3);
    // Every value is isolated between gaps, so nothing is drawable as a run of two.
    expect(segments).toHaveLength(0);
  });

  it("draws nothing when there is no data, or only one point", () => {
    expect(sparklineGeometry([], W, H)).toEqual({
      segments: [],
      domain: null,
      drawable: 0,
    });
    expect(sparklineGeometry([null, null], W, H).segments).toHaveLength(0);
    expect(sparklineGeometry([5], W, H).segments).toHaveLength(0);
  });
});
