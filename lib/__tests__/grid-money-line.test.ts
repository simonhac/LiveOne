/**
 * The two pure pieces behind the legend tables' grid money line (Import Cost / Export Credit):
 * the coverage guard that decides whether a window total is quotable at all, and the forward-fill
 * that makes a 30-minute price series readable on the Day chart's 5-minute grid.
 */
import { describe, it, expect } from "@jest/globals";
import { quotableCents } from "@/components/EnergyTable";
import { forwardFillRate } from "@/lib/site-data-processor";

describe("quotableCents", () => {
  it("quotes a fully-priced window", () => {
    expect(quotableCents(1397, 5.12, 5.12)).toBe(1397);
  });

  it("suppresses a partially-priced window rather than under-reporting it", () => {
    // The failure this exists for: 54.8 kWh exported, a sliver of it priced, "$0.08" rendered as if
    // it were the whole window.
    expect(quotableCents(8, 0.3, 54.8)).toBeNull();
  });

  it("brackets the 99.5% threshold", () => {
    expect(quotableCents(100, 99.4, 100)).toBeNull();
    expect(quotableCents(100, 99.6, 100)).toBe(100);
    expect(quotableCents(100, 99.5, 100)).toBe(100); // exactly at the bound quotes
  });

  it("passes null through, and never quotes against zero energy", () => {
    expect(quotableCents(null, 0, 0)).toBeNull();
    expect(quotableCents(0, 0, 0)).toBeNull();
  });

  it("quotes a negative total (an export that cost you) as readily as a positive one", () => {
    expect(quotableCents(-120, 5, 5)).toBe(-120);
  });
});

describe("forwardFillRate", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 7, 2, 0, minutes));
  /** A 5-minute grid, `count` buckets long. */
  const grid = (count: number) =>
    Array.from({ length: count }, (_, i) => at(i * 5));

  it("holds a 30-minute price across the 5-minute buckets between ticks", () => {
    const values = [12.5, null, null, null, null, null, 13.0];
    expect(forwardFillRate(grid(7), values)).toEqual([
      12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 13.0,
    ]);
  });

  it("stops holding past 35 minutes — a missed tick reads null, not a stale price", () => {
    // 8 buckets = 0…35 min. The 35-min bucket is still in range; the 40-min one is not.
    const values = [12.5, ...Array(8).fill(null)];
    const filled = forwardFillRate(grid(9), values);
    expect(filled[7]).toBe(12.5); // t+35min
    expect(filled[8]).toBeNull(); // t+40min
  });

  it("leaves the head null until the first real value", () => {
    expect(forwardFillRate(grid(3), [null, null, 9.9])).toEqual([
      null,
      null,
      9.9,
    ]);
  });

  it("never fills across a 1d grid — a hovered day shows only its own average", () => {
    const days = [0, 1, 2].map((d) => new Date(Date.UTC(2026, 7, 1 + d)));
    expect(forwardFillRate(days, [19.5, null, 28.5])).toEqual([
      19.5,
      null,
      28.5,
    ]);
  });

  it("holds a negative price (an export tariff that pays you) like any other", () => {
    expect(forwardFillRate(grid(3), [-1.98, null, null])).toEqual([
      -1.98, -1.98, -1.98,
    ]);
  });
});
