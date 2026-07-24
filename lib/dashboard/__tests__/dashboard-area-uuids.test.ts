import { describe, it, expect } from "@jest/globals";
import { Area, newUuidV7 } from "@/lib/ids";
import { isDashboardV4, type DashboardV4 } from "../v4";
import { dashboardAreaUuids } from "../composition";
import type { DashboardV3 } from "../v3";

describe("isDashboardV4", () => {
  it("accepts a v4 doc, rejects v3 / malformed", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: { kind: "group", children: [] },
    };
    expect(isDashboardV4(doc)).toBe(true);
    expect(isDashboardV4({ version: 3, sections: [] })).toBe(false);
    expect(isDashboardV4(null)).toBe(false);
    expect(isDashboardV4({ version: 4 })).toBe(false); // no root
    expect(isDashboardV4({ version: 4, root: { kind: "card" } })).toBe(false);
  });
});

describe("dashboardAreaUuids — dual-shape", () => {
  const u1 = newUuidV7();
  const u2 = newUuidV7();

  it("reads a v3 descriptor's section area ids (doc null)", () => {
    const descriptor: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: u1, cards: [] },
        { areaId: u2, cards: [] },
      ],
    };
    expect(dashboardAreaUuids({ descriptor, doc: null }).sort()).toEqual(
      [u1, u2].sort(),
    );
  });

  it("reads a v4 doc's envelope area refs (decoded to uuids), taking precedence over descriptor", () => {
    const doc: DashboardV4 = {
      version: 4,
      root: {
        kind: "group",
        children: [
          { kind: "group", area: Area.encode(u1), heading: true, children: [] },
        ],
      },
    };
    // descriptor here is a non-empty v3, but the v4 doc wins.
    const descriptor: DashboardV3 = {
      version: 3,
      sections: [{ areaId: u2, cards: [] }],
    };
    expect(dashboardAreaUuids({ descriptor, doc })).toEqual([u1]);
  });

  it("returns [] for an empty v3 descriptor", () => {
    expect(
      dashboardAreaUuids({
        descriptor: { version: 3, sections: [] },
        doc: null,
      }),
    ).toEqual([]);
  });
});
