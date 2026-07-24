import { describe, expect, it } from "@jest/globals";
import { Area, Binding, Device, Point } from "@/lib/ids";
import { areaDetailResponse } from "../v4-shapes";

describe("final v4 area detail wire shape", () => {
  it("contains only TypeIDs for entity identities and no compatibility keys", () => {
    const area = Area.generate();
    const member = Device.generate();
    const binding = Binding.generate();
    const point = Point.generate();
    const result = areaDetailResponse({
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
      },
      members: [
        {
          id: member,
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
    });

    expect(result).toEqual({
      area: {
        id: area,
        name: "Site",
        slug: "site",
        status: "active",
        dayOffsetMin: 600,
        displayTimezone: "Australia/Melbourne",
        location: null,
        config: {},
        capabilities: ["solar/power"],
      },
      members: [
        {
          id: member,
          name: "Inverter",
          vendor: "test",
          status: "active",
          capabilities: ["battery/soc"],
        },
      ],
      bindings: [
        {
          id: binding,
          role: "solar",
          metricType: "power",
          pointId: point,
          priority: 0,
          transform: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /legacySystemId|systemId|pointSystemId|ordinal/,
    );
  });
});
