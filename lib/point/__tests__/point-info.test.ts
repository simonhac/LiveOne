/**
 * `PointInfo` carries the point's identity — config-v4 Phase 12 slice D.
 *
 * The class had no direct tests at all, and the defect this guards is SILENT: before slice D
 * PR 2 the class simply had no `pointUid` member, so `from()` accepted a row that carried one
 * and dropped it on the floor. Every consumer then round-tripped `RegistryCache.pointForAddr`
 * to rediscover a uuid it already held.
 *
 * Both tests below were verified to FAIL against the pre-change class (the first on the missing
 * property, the second because nothing validated the input) — a test that passes either way is
 * worthless against an omission.
 */
import { describe, it, expect } from "@jest/globals";
import { PointInfo, type PointInfoWire } from "../point-info";

const UID = "019ec06c-f635-7000-8000-000000000001";

function wire(overrides: Partial<PointInfoWire> = {}): PointInfoWire {
  return {
    pointUid: UID,
    index: 3,
    systemId: 14,
    physicalPathTail: "engine/speed",
    logicalPathStem: "generator.engine",
    metricType: "speed",
    metricUnit: "rpm",
    defaultName: "Engine Speed",
    displayName: null,
    subsystem: null,
    transform: null,
    active: true,
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: null,
    ...overrides,
  };
}

describe("PointInfo identity", () => {
  it("carries pointUid through from() and onto the wire", () => {
    const p = PointInfo.from(wire());

    expect(p.pointUid).toBe(UID);
    // The wire shape is the instance's own properties — this is what NextResponse.json emits,
    // and what the client hands back to from(). A round trip must not lose the identity.
    expect(JSON.parse(JSON.stringify(p)).pointUid).toBe(UID);
    expect(PointInfo.from(JSON.parse(JSON.stringify(p))).pointUid).toBe(UID);
  });

  it("throws when pointUid is absent, rather than building a point with no identity", () => {
    // `point_info.point_uid` is NOT NULL, so this can only mean a producer dropped it — most
    // likely a route that stopped projecting the column. Loud beats a `string` holding undefined.
    const noUid = { ...wire() } as Partial<PointInfoWire>;
    delete noUid.pointUid;

    expect(() => PointInfo.from(noUid as PointInfoWire)).toThrow(/pointUid/);
    expect(() => PointInfo.from(wire({ pointUid: "" }))).toThrow(/pointUid/);
  });

  it("still exposes the legacy address alongside the identity", () => {
    // The (systemId, index) address is what Phase 13 deletes; until then both must be present,
    // because the converted read paths still re-key their SERVED rows on the integer index.
    const p = PointInfo.from(wire());
    expect(p.getReference().toString()).toBe("14.3");
    expect(p.name).toBe("Engine Speed");
  });
});
