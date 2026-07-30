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

  it("reads a v3 descriptor's section area ids, decoding ar_ to uuid (doc null)", () => {
    const descriptor: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: Area.encode(u1), cards: [] },
        { areaId: Area.encode(u2), cards: [] },
      ],
    };
    expect(dashboardAreaUuids({ descriptor, doc: null }).sort()).toEqual(
      [u1, u2].sort(),
    );
  });

  // config-v4 Phase 14: decode is STRICT — the dual-accept raw-uuid leg is gone. This is the
  // inverted assertion, and it is the most important test in this file, because the failure mode is
  // SILENT: a raw uuid does not throw, it is filtered out. That NARROWS the authorization set
  // (fail-closed — a section vanishes rather than becoming readable by the wrong person), so nothing
  // downstream errors. The guarantee that no raw uuid is ever stored therefore lives entirely in the
  // WRITE paths: `POST /api/dashboards` encodes, `PATCH /api/dashboards/{id}` 400s on a non-`ar_`
  // section ref (see `descriptorAreaRefsAreStrict`).
  it("STRICT: silently DROPS a raw-uuid section ref, keeping only the ar_ one", () => {
    const descriptor: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: u1, cards: [] }, // raw uuid — no longer decodable
        { areaId: Area.encode(u2), cards: [] }, // ar_
      ],
    };
    expect(dashboardAreaUuids({ descriptor, doc: null })).toEqual([u2]);
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
      sections: [{ areaId: Area.encode(u2), cards: [] }],
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
