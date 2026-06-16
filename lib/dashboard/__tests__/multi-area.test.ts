import { describe, it, expect } from "@jest/globals";
import {
  MULTI_AREA_CARD_TYPES,
  isMultiAreaCardType,
  offAreaCards,
} from "../multi-area";
import type { DashboardDescriptor, ModuleCardInstance } from "../descriptor";

function descriptor(cards: ModuleCardInstance[]): DashboardDescriptor {
  return { version: 2, layout: "site", cards };
}

// areaId → legacy_system_id resolution used by the tests (page system is 1).
const RESOLVE: Record<string, number> = {
  "area-page": 1, // the page's own Area
  "area-farm": 2,
  "area-ev": 3,
};
const resolve = (areaId: string): number | undefined => RESOLVE[areaId];

describe("isMultiAreaCardType", () => {
  it("includes the composable types and excludes the page-scoped ones", () => {
    expect(MULTI_AREA_CARD_TYPES).toEqual([
      "tiles",
      "chart",
      "amber-timeline",
      "generator-runs",
    ]);
    for (const t of MULTI_AREA_CARD_TYPES)
      expect(isMultiAreaCardType(t)).toBe(true);
    expect(isMultiAreaCardType("sankey")).toBe(false);
    expect(isMultiAreaCardType("grid-signals")).toBe(false);
    expect(isMultiAreaCardType("amber-now")).toBe(false);
  });
});

describe("offAreaCards", () => {
  it("returns nothing for a single-area dashboard (no areaId cards)", () => {
    const d = descriptor([
      { type: "tiles" },
      { type: "chart", id: "chart:lines" },
    ]);
    expect(offAreaCards(d, resolve, 1)).toEqual([]);
  });

  it("selects visible off-area cards of a composable type", () => {
    const farm: ModuleCardInstance = {
      type: "chart",
      id: "chart@farm",
      areaId: "area-farm",
    };
    const evTiles: ModuleCardInstance = {
      type: "tiles",
      id: "tiles@ev",
      areaId: "area-ev",
    };
    const d = descriptor([{ type: "tiles" }, farm, evTiles]);
    expect(offAreaCards(d, resolve, 1)).toEqual([farm, evTiles]);
  });

  it("skips a card whose Area resolves back to the PAGE system (not off-area)", () => {
    const d = descriptor([
      { type: "chart", id: "chart@self", areaId: "area-page" },
    ]);
    expect(offAreaCards(d, resolve, 1)).toEqual([]);
  });

  it("skips hidden cards, non-composable types, and unresolvable Areas", () => {
    const d = descriptor([
      { type: "chart", id: "h", areaId: "area-farm", hidden: true }, // hidden
      { type: "sankey", id: "s", areaId: "area-farm" }, // not composable
      { type: "chart", id: "g", areaId: "area-ghost" }, // unresolvable uuid
    ]);
    expect(offAreaCards(d, resolve, 1)).toEqual([]);
  });

  it("returns [] for a null descriptor", () => {
    expect(offAreaCards(null, resolve, 1)).toEqual([]);
  });
});
