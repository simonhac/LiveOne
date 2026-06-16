import { describe, it, expect } from "@jest/globals";
import {
  emptyCompositionDescriptor,
  buildSeedDescriptor,
  descriptorAreaIds,
} from "../composition";

const AREA = { id: "11111111-2222-3333-4444-555555555555" };

describe("emptyCompositionDescriptor", () => {
  it("is a v2 descriptor with no cards", () => {
    const d = emptyCompositionDescriptor();
    expect(d.version).toBe(2);
    expect(d.cards).toEqual([]);
  });
});

describe("buildSeedDescriptor", () => {
  it("stamps every card with the seed Area id + a unique instance id", () => {
    // selectronic → sidebar layout: tiles, chart:lines, generator-runs.
    const d = buildSeedDescriptor(AREA, { vendorType: "selectronic" });
    expect(d.cards.length).toBeGreaterThan(0);
    for (const c of d.cards) {
      expect(c.areaId).toBe(AREA.id);
      expect(typeof c.id).toBe("string");
    }
    const ids = d.cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // all ids unique
  });

  it("derives the starter card set from the seed system's vendor type", () => {
    const site = buildSeedDescriptor(AREA, { vendorType: "mondo" });
    // site layout includes a sankey; sidebar (selectronic) does not.
    expect(site.cards.some((c) => c.type === "sankey")).toBe(true);
    const sidebar = buildSeedDescriptor(AREA, { vendorType: "selectronic" });
    expect(sidebar.cards.some((c) => c.type === "sankey")).toBe(false);
  });
});

describe("descriptorAreaIds", () => {
  it("returns the distinct areaIds across cards", () => {
    const d = {
      version: 2 as const,
      layout: "site" as const,
      cards: [
        { type: "tiles" as const, id: "a", areaId: "area-1" },
        { type: "chart" as const, id: "b", areaId: "area-2" },
        { type: "generator-runs" as const, id: "c", areaId: "area-1" },
        { type: "sankey" as const, id: "d" }, // no areaId → ignored
      ],
    };
    expect(descriptorAreaIds(d).sort()).toEqual(["area-1", "area-2"]);
  });
});
