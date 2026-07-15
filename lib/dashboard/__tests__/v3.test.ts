import { describe, it, expect } from "@jest/globals";
import { normalizeDescriptor, type DashboardV3 } from "../v3";

const AREA = "11111111-2222-3333-4444-555555555555";

describe("normalizeDescriptor (sankey card ids)", () => {
  it("assigns the stable id 'sankey' to a lone id-less sankey card", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [{ areaId: AREA, cards: [{ type: "sankey" }] }],
    };
    const out = normalizeDescriptor(d);
    expect(out.sections[0].cards[0].id).toBe("sankey");
  });

  it("preserves an existing sankey id (idempotent)", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [{ areaId: AREA, cards: [{ type: "sankey", id: "keep" }] }],
    };
    const once = normalizeDescriptor(d);
    expect(once.sections[0].cards[0].id).toBe("keep");
    expect(normalizeDescriptor(once)).toEqual(once);
  });

  it("disambiguates multiple id-less sankeys in one section", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: AREA, cards: [{ type: "sankey" }, { type: "sankey" }] },
      ],
    };
    const out = normalizeDescriptor(d);
    expect(out.sections[0].cards.map((c) => c.id)).toEqual([
      "sankey",
      "sankey:1",
    ]);
  });

  it("leaves non-sankey cards untouched (no id invented)", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [
        {
          areaId: AREA,
          cards: [{ type: "tiles", tiles: [] }, { type: "sankey" }],
        },
      ],
    };
    const out = normalizeDescriptor(d);
    expect(out.sections[0].cards[0].id).toBeUndefined();
    expect(out.sections[0].cards[1].id).toBe("sankey");
  });
});
