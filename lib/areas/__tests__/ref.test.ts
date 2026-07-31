import { describe, it, expect } from "@jest/globals";
import { Area, newUuidV7 } from "@/lib/ids";
import { areaRefToUuid, areaRefToArId } from "../ref";

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

// `descriptorAreaRefsAreStrict` and `encodeDescriptorAreaRefs` were deleted by config-v4 Phase 14
// stage 15, along with their suites: both operated on `dashboards.descriptor`, which nothing reads or
// writes any more. The invariant they existed to protect — that a stored area ref is always `ar_` —
// is now carried entirely by the v4 document's write-path validation.
