/**
 * `points.transform`, applied in one place.
 *
 * The property being pinned is not arithmetic — it is that the KV latest cache and the series
 * readers present the SAME convention. They disagreed for over a year, and the disagreement was
 * only visible by comparing two CLI commands against each other.
 */
import { describe, it, expect } from "@jest/globals";
import { canonicalValue } from "../canonical-value";

/**
 * Measured at Daylesford during the 2026-09-12 generator run: the stored column holds −3813 while
 * the generator supplies ~3.8 kW to the house, corroborated by `bidi.grid.import/energy` rising
 * 0.60 kWh over the same 11 minutes.
 */
const STORED_WHILE_IMPORTING = -3813;

describe("canonicalValue", () => {
  it("🛑 flips an 'i' point, which is what the KV cache was not doing", () => {
    expect(canonicalValue(STORED_WHILE_IMPORTING, "i")).toBe(3813);
  });

  it("flips the other direction too — it is a sign convention, not a clamp", () => {
    expect(canonicalValue(2100, "i")).toBe(-2100);
  });

  // 🛑 'd' is a DELTA mechanism for energy counters, not a sign flip. Negating it would turn every
  // meter reading in the fleet upside down, which is a far larger blast radius than the bug.
  it("🛑 leaves 'd' alone — that is deltas, not an inversion", () => {
    expect(canonicalValue(209146, "d")).toBe(209146);
  });

  it("leaves an untransformed point alone", () => {
    for (const t of [null, undefined, "n"])
      expect(canonicalValue(419, t)).toBe(419);
  });

  it("does not emit -0", () => {
    expect(Object.is(canonicalValue(0, "i"), -0)).toBe(false);
    expect(canonicalValue(0, "i")).toBe(0);
  });

  // A missing reading is not a zero, and a text point has no sign to correct. Both would be real
  // damage if coerced: `null → 0` reads as "the generator was off" to anything measuring load.
  it("passes null and non-numeric values through untouched", () => {
    expect(canonicalValue(null, "i")).toBeNull();
    expect(canonicalValue("Auto", "i")).toBe("Auto");
    expect(canonicalValue(undefined, "i")).toBeUndefined();
  });

  it("is its own inverse, so applying it twice is a no-op", () => {
    const once = canonicalValue(STORED_WHILE_IMPORTING, "i");
    expect(canonicalValue(once, "i")).toBe(STORED_WHILE_IMPORTING);
  });

  // The agreement that matters: what `/api/history` shows and what the KV cache now stores are the
  // same number. `build-series.ts` applies `transform === "i" ? -value : value`; so does this.
  it("🛑 agrees with the series readers' flip, which is the whole point", () => {
    const seriesFlip = (v: number, t: string | null) => (t === "i" ? -v : v);
    for (const v of [STORED_WHILE_IMPORTING, 2100, 4, -4, 0])
      expect(canonicalValue(v, "i")).toBe(seriesFlip(v, "i") + 0);
  });
});
