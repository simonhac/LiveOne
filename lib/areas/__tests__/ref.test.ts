import { describe, it, expect } from "@jest/globals";
import { Area, newUuidV7 } from "@/lib/ids";
import {
  areaRefToUuid,
  areaRefToArId,
  encodeDescriptorAreaRefs,
  descriptorAreaRefsAreStrict,
} from "../ref";
import type { DashboardV3 } from "@/lib/dashboard/v3";

describe("areaRefToUuid — STRICT decode (config-v4 Phase 14)", () => {
  it("decodes an ar_ id to its uuid", () => {
    const uuid = newUuidV7();
    expect(areaRefToUuid(Area.encode(uuid))).toBe(uuid);
  });

  it("REJECTS a raw uuid — the dual-accept leg is gone", () => {
    const uuid = newUuidV7();
    expect(areaRefToUuid(uuid)).toBeNull();
  });

  it("rejects a foreign-entity id and garbage", () => {
    expect(areaRefToUuid("dv_01h455vb4pex5vsknk084sn02q")).toBeNull();
    expect(areaRefToUuid("garbage")).toBeNull();
    expect(areaRefToUuid("device-14")).toBeNull();
  });
});

describe("descriptorAreaRefsAreStrict", () => {
  const uuid = newUuidV7();

  it("is true when every section ref is ar_", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: Area.encode(uuid), cards: [] },
        { areaId: Area.generate(), cards: [] },
      ],
    };
    expect(descriptorAreaRefsAreStrict(d)).toBe(true);
  });

  it("is vacuously true for a descriptor with no sections", () => {
    expect(descriptorAreaRefsAreStrict({ version: 3, sections: [] })).toBe(
      true,
    );
  });

  // The point of the gate: these are exactly the refs `areaRefToUuid` now drops SILENTLY, which
  // would otherwise let a write skip the no-escalation check and re-dirty the column.
  it("is false when ANY section ref is a raw uuid", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: Area.encode(uuid), cards: [] },
        { areaId: newUuidV7(), cards: [] },
      ],
    };
    expect(descriptorAreaRefsAreStrict(d)).toBe(false);
  });

  it("is false for a device sentinel or garbage ref", () => {
    expect(
      descriptorAreaRefsAreStrict({
        version: 3,
        sections: [{ areaId: "device-14", cards: [] }],
      }),
    ).toBe(false);
    expect(
      descriptorAreaRefsAreStrict({
        version: 3,
        sections: [{ areaId: "garbage", cards: [] }],
      }),
    ).toBe(false);
  });
});

describe("areaRefToArId", () => {
  it("is a no-op on an already-ar_ id", () => {
    const ar = Area.generate();
    expect(areaRefToArId(ar)).toBe(ar);
  });

  it("encodes a raw uuid to ar_", () => {
    const uuid = newUuidV7();
    expect(areaRefToArId(uuid)).toBe(Area.encode(uuid));
  });

  it("returns null for a value that is neither form", () => {
    expect(areaRefToArId("device-14")).toBeNull();
    expect(areaRefToArId("garbage")).toBeNull();
  });
});

describe("encodeDescriptorAreaRefs", () => {
  const uuid1 = newUuidV7();
  const uuid2 = newUuidV7();

  it("encodes every section's raw-uuid areaId to ar_", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: uuid1, cards: [] },
        { areaId: uuid2, cards: [] },
      ],
    };
    const out = encodeDescriptorAreaRefs(d);
    expect(out.sections[0].areaId).toBe(Area.encode(uuid1));
    expect(out.sections[1].areaId).toBe(Area.encode(uuid2));
  });

  it("is idempotent on an already-encoded descriptor", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [{ areaId: Area.encode(uuid1), cards: [] }],
    };
    const once = encodeDescriptorAreaRefs(d);
    const twice = encodeDescriptorAreaRefs(once);
    expect(twice).toEqual(once);
    expect(once.sections[0].areaId).toBe(Area.encode(uuid1));
  });

  it("leaves an unrecognized ref (e.g. a /device sentinel) untouched", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [{ areaId: "device-14", cards: [] }],
    };
    expect(encodeDescriptorAreaRefs(d).sections[0].areaId).toBe("device-14");
  });

  it("handles multiple sections independently in one pass", () => {
    const d: DashboardV3 = {
      version: 3,
      sections: [
        { areaId: uuid1, cards: [] },
        { areaId: Area.encode(uuid2), cards: [] },
        { areaId: "device-1", cards: [] },
      ],
    };
    const out = encodeDescriptorAreaRefs(d);
    expect(out.sections.map((s) => s.areaId)).toEqual([
      Area.encode(uuid1),
      Area.encode(uuid2),
      "device-1",
    ]);
  });
});
