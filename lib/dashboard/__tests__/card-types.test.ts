/**
 * The v4 card-type vocabulary + the renderer's closed dispatch (`node-view.tsx`).
 *
 * The classification half of the deleted `v4-adapt.test.ts` (config-v4 Phase 14 stage 6) lives here:
 * `isV3CardType` → `isNonTileCardType` and `v4CardRenderKind` moved out of the adapter into the
 * module that owns the vocabulary. The `synthCardV3`/`synthSectionV3` half died with the adapter —
 * plugins now read `node.config` / `context.area` directly, which the render-props gate
 * (`v4-render-props.test.ts`) covers end to end.
 */
import { describe, it, expect } from "@jest/globals";
import {
  V4_CARD_TYPES,
  V4_NON_TILE_CARD_TYPES,
  V4_TILE_TYPES,
  isKnownCardType,
  isNonTileCardType,
  isTileViewType,
  v4CardRenderKind,
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
    for (const t of ["chart", "sankey", "generator-runs", "tiles", "nope"]) {
      expect(isTileViewType(t)).toBe(false);
    }
  });

  it("isNonTileCardType covers the card-plugin types (not tile views, not `tiles`)", () => {
    for (const t of [
      "chart",
      "sankey",
      "amber-now",
      "generator-runs",
      "device-metrics",
      "battery-contents",
    ]) {
      expect(isNonTileCardType(t)).toBe(true);
    }
    for (const t of ["solar", "oe-grid", "tiles", "future-card"]) {
      expect(isNonTileCardType(t)).toBe(false);
    }
  });

  it("routes an unknown string to the labelled-placeholder branch", () => {
    expect(v4CardRenderKind("solar")).toBe("tile");
    expect(v4CardRenderKind("chart")).toBe("card");
    expect(v4CardRenderKind("future-card")).toBe("unknown");
    expect(v4CardRenderKind("tiles")).toBe("unknown");
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
