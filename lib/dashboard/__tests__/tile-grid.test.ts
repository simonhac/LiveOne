import { describe, it, expect } from "@jest/globals";
import { tileGridClass, tileRowClass, TILE_GRID_POLICY } from "../tile-grid";

const { tiers, maxTabulatedCount, columnsFor, colsByCount, colsAtCap } =
  TILE_GRID_POLICY;

/** The class string the policy formula implies for `n` tiles — what the literal table must equal. */
function derive(n: number): string {
  return tiers
    .map(({ minWidth, cap }, i) => {
      const cols = columnsFor(n, cap);
      return i === 0
        ? `grid-cols-${cols}`
        : `@[${minWidth}px]:grid-cols-${cols}`;
    })
    .join(" ");
}

describe("tile grid policy", () => {
  it("the literal table matches the formula for every tabulated count", () => {
    for (let n = 1; n <= maxTabulatedCount; n++) {
      expect([n, colsByCount[n]]).toEqual([n, derive(n)]);
    }
  });

  it("the past-the-table fallback runs every tier at its cap", () => {
    const atCap = tiers
      .map(({ minWidth, cap }, i) =>
        i === 0 ? `grid-cols-${cap}` : `@[${minWidth}px]:grid-cols-${cap}`,
      )
      .join(" ");
    expect(colsAtCap).toBe(atCap);
    expect(tileGridClass(maxTabulatedCount + 1)).toContain(colsAtCap);
  });

  it("uses the fewest rows that fit within the cap", () => {
    for (let n = 1; n <= 24; n++) {
      for (const { cap } of tiers) {
        const cols = columnsFor(n, cap);
        expect(cols).toBeGreaterThan(0);
        expect(cols).toBeLessThanOrEqual(cap);
        expect(Math.ceil(n / cols)).toBe(Math.ceil(n / cap)); // no extra row
      }
    }
  });

  it("orphans a lone tile on the last row only when unavoidable", () => {
    const orphans = (n: number, cols: number) => cols > 1 && n % cols === 1;
    for (let n = 1; n <= 24; n++) {
      for (const { cap } of tiers) {
        if (!orphans(n, columnsFor(n, cap))) continue;
        // Every other column count that fits the cap in the same (minimal) number of rows must
        // orphan too — i.e. we never picked a worse layout than one that was available.
        const rows = Math.ceil(n / cap);
        const better: number[] = [];
        for (let c = 1; c <= cap; c++) {
          if (Math.ceil(n / c) === rows && !orphans(n, c)) better.push(c);
        }
        expect({ n, cap, better }).toEqual({ n, cap, better: [] });
      }
    }
  });

  it("lays 8 tiles out 4x2 on desktop and 2-up on mobile", () => {
    const eight = tileGridClass(8);
    expect(eight).toContain("grid-cols-2 "); // base tier
    expect(eight).toContain("@[752px]:grid-cols-4");
    expect(eight).toContain("@[1136px]:grid-cols-4");
  });

  it("keeps 5 tiles on one row once they fit", () => {
    const five = tileGridClass(5);
    expect(five).toContain("@[944px]:grid-cols-5");
    expect(five).toContain("@[1136px]:grid-cols-5");
  });

  it("always carries the shared grid chrome", () => {
    for (const cls of [tileGridClass(8), tileRowClass()]) {
      expect(cls).toContain("grid ");
      expect(cls).toContain("auto-rows-fr");
      expect(cls).toContain("gap-2");
    }
  });

  it("forces a single equal-width row when wrapping is off", () => {
    expect(tileRowClass()).toContain("grid-flow-col auto-cols-fr");
  });
});
