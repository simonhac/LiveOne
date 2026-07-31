import { describe, expect, it } from "@jest/globals";
import { Area, Binding, Device, Point } from "@/lib/ids";
import { areaDetailResponse } from "../v4-shapes";

/**
 * ⚠️ This suite USED to assert `expect(JSON.stringify(result)).not.toMatch(/legacySystemId|…/)` — a
 * blanket ban that read as rigour and was in fact the bug: it pinned the v4 area payload as strictly
 * NARROWER than the legacy twin the clients actually read, on a surface nothing called. The ban now
 * covers legacy IDENTITY keys only (`systemId`, `pointSystemId`, `ordinal`), and `legacySystemId` — the
 * integer ADDRESS `/api/data?systemId=` and the KV keyspace still use — is pinned as PRESENT. When the
 * handle finally dies it leaves this payload and `GET /api/areas/{areaId}` in the same commit.
 */
const source = () => {
  const area = Area.generate();
  const member = Device.generate();
  const binding = Binding.generate();
  const point = Point.generate();
  return {
    ids: { area, member, binding, point },
    input: {
      area: {
        id: Area.toUuid(area),
        name: "Site",
        slug: "site",
        status: "active",
        dayOffsetMin: 600,
        timezoneOffsetMin: 600,
        displayTimezone: "Australia/Melbourne",
        location: null,
        config: null,
        capabilities: ["solar/power"],
        legacySystemId: 7 as number | null,
      },
      members: [
        {
          id: member,
          legacySystemId: 42,
          name: "Inverter",
          vendor: "test",
          status: "active",
          capabilities: ["battery/soc"],
        },
      ],
      bindings: [
        {
          id: Binding.toUuid(binding),
          role: "solar",
          metricType: "power",
          pointUid: Point.toUuid(point),
          priority: 0,
          transform: null,
        },
      ],
    },
  };
};

describe("final v4 area detail wire shape", () => {
  it("uses TypeIDs for every entity identity, and no legacy identity keys", () => {
    const { ids, input } = source();
    const result = areaDetailResponse(input);

    expect(result).toEqual({
      area: {
        id: ids.area,
        name: "Site",
        slug: "site",
        status: "active",
        dayOffsetMin: 600,
        displayTimezone: "Australia/Melbourne",
        location: null,
        config: {},
        capabilities: ["solar/power"],
        legacySystemId: 7,
      },
      members: [
        {
          id: ids.member,
          legacySystemId: 42,
          name: "Inverter",
          vendor: "test",
          status: "active",
          capabilities: ["battery/soc"],
        },
      ],
      bindings: [
        {
          id: ids.binding,
          role: "solar",
          metricType: "power",
          pointId: ids.point,
          priority: 0,
          transform: null,
        },
      ],
    });
    // Legacy IDENTITY keys stay banned — a member is a `dv_`, a binding target is a `pt_`.
    expect(JSON.stringify(result)).not.toMatch(
      /"systemId"|pointSystemId|ordinal/,
    );
  });

  it("carries the integer data ADDRESS per MEMBER too — the Bindings tab's point-fetch key", () => {
    // A member's handle is what `GET /api/device/{handle}/points` is addressed by. Re-deriving it by
    // joining `GET /api/v4/devices` drops any member that route filters out (it is `activeOnly`), so a
    // `status='removed'` member would silently lose its points from the picker.
    const { ids, input } = source();
    const [member] = areaDetailResponse(input).members;
    expect(member).toEqual({
      id: ids.member,
      legacySystemId: 42,
      name: "Inverter",
      vendor: "test",
      status: "active",
      capabilities: ["battery/soc"],
    });
  });

  it("carries the integer data ADDRESS, exactly as GET /api/areas/{areaId} does", () => {
    const { input } = source();
    expect(areaDetailResponse(input).area.legacySystemId).toBe(7);
    // Nullable: an area with no `legacy_handles` row is representable and must not become `undefined`
    // (which JSON.stringify drops entirely, turning a known-absent handle into a missing key).
    expect(
      areaDetailResponse({
        ...input,
        area: { ...input.area, legacySystemId: null },
      }).area.legacySystemId,
    ).toBeNull();
  });

  it("emits the canonical day offset, falling back to the timezone offset", () => {
    const { input } = source();
    // §7 / locked decision 9: the fixed day offset is canonical, so `timezoneOffsetMin` is deliberately
    // NOT on the wire — `dayOffsetMin` carries the same number under the name v4 means. That is a
    // rename, not a narrowing.
    const withoutDayOffset = areaDetailResponse({
      ...input,
      area: { ...input.area, dayOffsetMin: null },
    });
    expect(withoutDayOffset.area.dayOffsetMin).toBe(600);
    expect(withoutDayOffset.area).not.toHaveProperty("timezoneOffsetMin");
  });
});
