import { describe, it, expect } from "@jest/globals";
import { Area, newUuidV7 } from "@/lib/ids";
import { isDashboardV4, type DashboardV4 } from "../v4";
import { dashboardAreaUuids } from "../composition";

// `dashboardAreaUuids` reads the `doc` and nothing else. The cases below assert that NO second shape
// is consulted when the guard fails — it resolves to an empty scope, not to a fallback document.

describe("isDashboardV4", () => {
  it("accepts a v4 doc, rejects a wrong-version doc / malformed", () => {
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

describe("dashboardAreaUuids — the v4 envelope walk", () => {
  const u1 = newUuidV7();
  const u2 = newUuidV7();

  const docWith = (...refs: string[]): unknown => ({
    version: 4,
    root: {
      kind: "group",
      children: refs.map((area) => ({
        kind: "group",
        area,
        heading: true,
        children: [],
      })),
    },
  });

  it("reads the envelope area refs, decoding ar_ to uuid, deduped", () => {
    const doc = docWith(Area.encode(u1), Area.encode(u2), Area.encode(u1));
    expect(dashboardAreaUuids({ doc }).sort()).toEqual([u1, u2].sort());
  });

  it("is empty for a document that references no areas", () => {
    expect(dashboardAreaUuids({ doc: docWith() })).toEqual([]);
  });

  // 🛑 The most important test in this file, because BOTH failure modes here are silent.
  //
  // (a) No second shape. A doc that fails the guard resolves to nothing. That is fail-closed — the
  //     dashboard authorizes no device rather than authorizing whatever a stale, divergent second
  //     document happened to name.
  it("returns [] for anything that is not a valid v4 doc — no fallback shape is consulted", () => {
    const staleV3 = {
      version: 3,
      sections: [{ areaId: Area.encode(u1), cards: [] }],
    };
    for (const doc of [null, undefined, {}, "nope", staleV3]) {
      expect(dashboardAreaUuids({ doc })).toEqual([]);
    }
  });

  // (b) Decode is STRICT: a raw uuid does not throw, it is FILTERED OUT. That narrows the
  //     authorization set (a section vanishes rather than becoming readable by the wrong person), so
  //     nothing downstream errors. The guarantee that no raw uuid is ever stored therefore lives
  //     entirely in the WRITE path — the v4 document validator, which rejects a non-`ar_` ref.
  it("STRICT: silently DROPS a raw-uuid area ref, keeping only the ar_ one", () => {
    expect(dashboardAreaUuids({ doc: docWith(u1, Area.encode(u2)) })).toEqual([
      u2,
    ]);
  });
});
