import { describe, it, expect } from "@jest/globals";
import { Area, newUuidV7 } from "@/lib/ids";
import { isDashboardV4, type DashboardV4 } from "../v4";
import { dashboardAreaUuids } from "../composition";

// config-v4 Phase 14 stage 15: `dashboardAreaUuids` used to be DUAL-SHAPE — a v4 `doc` if it passed
// the guard, else the v3 `descriptor`. `dashboards.descriptor` is now inert (dropped at stage 16), so
// the fallback is gone and this is a v4-only resolver. The v3 cases below were deleted with it; what
// replaced them is the assertion that NO second shape is consulted.
//
// `composition.test.ts` was folded in here at the same time: its two subjects
// (`emptyCompositionDescriptor`, `descriptorAreaIds`) were deleted with the column, leaving
// `dashboardAreaUuids` as the module's only export — and this is the file named for it.

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
  // (a) No second shape. A doc that fails the guard used to fall back to the v3 descriptor; now it
  //     resolves to nothing. That is fail-closed — the dashboard authorizes no device rather than
  //     authorizing whatever a stale, divergent descriptor happened to name.
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
