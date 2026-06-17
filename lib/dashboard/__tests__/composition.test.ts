import { describe, it, expect } from "@jest/globals";
import {
  emptyCompositionDescriptor,
  buildSeedDescriptor,
  descriptorAreaIds,
} from "../composition";

const AREA = { id: "11111111-2222-3333-4444-555555555555" };

describe("emptyCompositionDescriptor", () => {
  it("is a v3 descriptor with no sections", () => {
    const d = emptyCompositionDescriptor();
    expect(d.version).toBe(3);
    expect(d.sections).toEqual([]);
  });
});

describe("buildSeedDescriptor", () => {
  it("binds one AreaSection to the seed Area with a non-empty card set", () => {
    const d = buildSeedDescriptor(AREA, { vendorType: "selectronic" });
    expect(d.version).toBe(3);
    expect(d.sections.length).toBe(1);
    expect(d.sections[0].areaId).toBe(AREA.id);
    expect(d.sections[0].cards.length).toBeGreaterThan(0);
  });

  it("derives the starter card set from the seed system's vendor type", () => {
    // site layout (mondo) has stacked charts; sidebar (selectronic) a lines chart. The sankey is opt-in
    // (added explicitly), so it is in NO default — neither layout.
    const site = buildSeedDescriptor(AREA, { vendorType: "mondo" });
    expect(site.sections[0].cards.some((c) => c.type === "chart")).toBe(true);
    expect(site.sections[0].cards.some((c) => c.type === "sankey")).toBe(false);
    const sidebar = buildSeedDescriptor(AREA, { vendorType: "selectronic" });
    expect(sidebar.sections[0].cards.some((c) => c.type === "chart")).toBe(
      true,
    );
    expect(sidebar.sections[0].cards.some((c) => c.type === "sankey")).toBe(
      false,
    );
  });
});

describe("descriptorAreaIds", () => {
  it("returns the distinct section areaIds for a v3 descriptor", () => {
    const d = {
      version: 3 as const,
      sections: [
        { areaId: "area-1", cards: [] },
        { areaId: "area-2", cards: [] },
        { areaId: "area-1", cards: [] }, // duplicate → deduped
      ],
    };
    expect(descriptorAreaIds(d).sort()).toEqual(["area-1", "area-2"]);
  });

  it("returns the distinct card areaIds for a legacy v2 descriptor", () => {
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
