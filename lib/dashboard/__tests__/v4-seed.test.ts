import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Device, newUuidV7, type DeviceId } from "@/lib/ids";
import type { DashboardV3 } from "../v3";

jest.mock("@/lib/capabilities/server", () => ({
  buildAreaStrategyForHandle: jest.fn(),
}));
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: { addrsForHandles: jest.fn() },
}));

import { buildAreaStrategyForHandle } from "@/lib/capabilities/server";
import { DeviceRegistry } from "@/lib/registry";
import { buildPersistableSeedDoc, buildSeedGroupPreview } from "../v4-seed";
import { collectRefs, validateDocV4 } from "../v4-validate";

const mockStrategy = jest.mocked(buildAreaStrategyForHandle);
const mockMappings = jest.mocked(DeviceRegistry.addrsForHandles);

function seedLikeV3(areaId = newUuidV7()): DashboardV3 {
  return {
    version: 3,
    sections: [
      {
        areaId,
        cards: [
          {
            type: "tiles",
            tiles: [{ view: "solar" }, { view: "oe-grid", deviceSystemId: 14 }],
          },
          { type: "device-metrics", deviceSystemId: 1 },
          { type: "generator-runs", deviceSystemId: 9 },
        ],
      },
    ],
  };
}

function mapped(handles: number[]): Map<number, any> {
  return new Map(
    handles.map((handle) => {
      const deviceId: DeviceId = Device.generate();
      return [
        handle,
        {
          deviceId,
          uuid: Device.toUuid(deviceId),
          rid: handle,
          handle,
        },
      ];
    }),
  );
}

describe("authoritative config-v4 seeds", () => {
  beforeEach(() => {
    mockStrategy.mockReset();
    mockMappings.mockReset();
  });

  it("preview and persistence keep the same real device refs", async () => {
    const areaId = newUuidV7();
    mockStrategy.mockResolvedValue(seedLikeV3(areaId));
    const mappings = mapped([14, 1, 9]);
    mockMappings.mockResolvedValue(mappings);

    const [doc, group] = await Promise.all([
      buildPersistableSeedDoc(areaId, 1000001),
      buildSeedGroupPreview(areaId, 1000001),
    ]);

    expect(validateDocV4(doc).valid).toBe(true);
    expect(collectRefs(doc).devices.sort()).toEqual(
      [...mappings.values()].map((m) => m.deviceId).sort(),
    );
    expect(group).toEqual(doc.root.children[0]);
    expect(mockMappings).toHaveBeenCalledWith([14, 1, 9]);
  });

  it("fails explicitly rather than fabricating an unmapped device", async () => {
    const areaId = newUuidV7();
    mockStrategy.mockResolvedValue(seedLikeV3(areaId));
    mockMappings.mockResolvedValue(mapped([14, 1]));
    await expect(buildPersistableSeedDoc(areaId, 1000001)).rejects.toEqual(
      expect.objectContaining({
        name: "MissingDeviceMappingError",
        handles: [9],
      }),
    );
  });
});
