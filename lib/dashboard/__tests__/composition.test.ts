import { describe, it, expect } from "@jest/globals";
import { emptyCompositionDescriptor, descriptorAreaIds } from "../composition";

// buildSeedDescriptor was removed: a composition seed is now built server-side from the Area's
// capabilities via buildAreaStrategyForHandle (covered by lib/capabilities/__tests__/strategy-*.test.ts).

describe("emptyCompositionDescriptor", () => {
  it("is a v3 descriptor with no sections", () => {
    const d = emptyCompositionDescriptor();
    expect(d.version).toBe(3);
    expect(d.sections).toEqual([]);
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
