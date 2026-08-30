/**
 * The v4 card-type vocabulary — the closed set this build knows how to render and validate.
 *
 * VOCABULARY ONLY. Classification lives here because this module owns the vocabulary; RENDER
 * dispatch belongs to the one plugin registry, and what plugins actually receive is covered end to
 * end by the render-props gate (`v4-render-props.test.ts`).
 */
import { describe, it, expect } from "@jest/globals";
import {
  V4_CARD_TYPES,
  V4_NON_TILE_CARD_TYPES,
  V4_TILE_TYPES,
  isKnownCardType,
  isNonTileCardType,
  isTileViewType,
} from "../card-types";

describe("v4 card-type classification", () => {
  it("isTileViewType covers the 9 promoted tile views only", () => {
    for (const t of [
      "solar",
      "load",
      "hotWater",
      "battery",
      "house-to-grid",
      "amber",
      "ev",
      "renewables",
      "oe-grid",
    ]) {
      expect(isTileViewType(t)).toBe(true);
    }
    for (const t of ["chart", "sankey", "runs", "tiles", "nope"]) {
      expect(isTileViewType(t)).toBe(false);
    }
  });

  it("isNonTileCardType covers the card-plugin types (not tile views, not `tiles`)", () => {
    for (const t of [
      "chart",
      "sankey",
      "amber-now",
      "runs",
      "device-metrics",
      "battery-contents",
    ]) {
      expect(isNonTileCardType(t)).toBe(true);
    }
    for (const t of ["solar", "oe-grid", "tiles", "future-card"]) {
      expect(isNonTileCardType(t)).toBe(false);
    }
  });

  /**
   * §8.4: an unknown type — and `tiles`, which is a `row` group rather than a card — must be unknown
   * to this BUILD, so the renderer's one registry lookup misses and it takes the labelled-placeholder
   * branch. The render side is asserted end-to-end in `v4-render-props.test.ts`.
   */
  it("`tiles` and future types are NOT known card types (the §8.4 placeholder path)", () => {
    expect(isKnownCardType("tiles")).toBe(false);
    expect(isKnownCardType("future-card")).toBe(false);
    expect(isKnownCardType("")).toBe(false);
    expect(isKnownCardType("solar")).toBe(true);
    expect(isKnownCardType("chart")).toBe(true);
  });

  it("the three predicates partition the known card types exactly", () => {
    expect([...V4_CARD_TYPES].filter(isTileViewType)).toEqual([
      ...V4_TILE_TYPES,
    ]);
    expect([...V4_CARD_TYPES].filter(isNonTileCardType)).toEqual([
      ...V4_NON_TILE_CARD_TYPES,
    ]);
    for (const t of V4_CARD_TYPES) {
      expect(isKnownCardType(t)).toBe(true);
      expect(isTileViewType(t) !== isNonTileCardType(t)).toBe(true);
    }
  });
});
