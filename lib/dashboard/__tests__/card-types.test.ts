/**
 * The v4 card-type vocabulary — the closed set this build knows how to render and validate.
 *
 * The classification half of the deleted `v4-adapt.test.ts` (config-v4 Phase 14 stage 6) lives here:
 * `isV3CardType` → `isNonTileCardType`, moved out of the adapter into the module that owns the
 * vocabulary. The `synthCardV3`/`synthSectionV3` half died with the adapter — plugins now read
 * `node.config` / `context.area` directly, which the render-props gate (`v4-render-props.test.ts`)
 * covers end to end. Stage 7 then deleted `v4CardRenderKind`: RENDER dispatch belongs to the one
 * plugin registry, so what is left here is vocabulary only.
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
   * §8.4: an unknown type — and the v3 `tiles` container, which became a `row` group — must be
   * unknown to this BUILD, so the renderer's one registry lookup misses and it takes the labelled-
   * placeholder branch. (Stage 7 deleted `v4CardRenderKind`, which used to state the same thing a
   * second time; the render side of it is asserted end-to-end in `v4-render-props.test.ts`.)
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
