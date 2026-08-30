import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Area, Device, newUuidV7, type DeviceId } from "@/lib/ids";

jest.mock("@/lib/capabilities/server", () => ({
  resolveAreaStrategyInputs: jest.fn(),
}));
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: { addrsForHandles: jest.fn() },
}));

import { resolveAreaStrategyInputs } from "@/lib/capabilities/server";
import { DeviceRegistry } from "@/lib/registry";
import { buildPersistableSeedDoc, buildSeedGroupPreview } from "../v4-seed";
import { collectRefs, validateDocV4 } from "../v4-validate";
import { stripNodeIds } from "../node-ops";
import type { CapabilityId } from "@/lib/capabilities/registry";

const mockInputs = jest.mocked(resolveAreaStrategyInputs);
const mockMappings = jest.mocked(DeviceRegistry.addrsForHandles);

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);

/** A tiles-and-chart area that also carries the OE grid pin (legacy handle 12). */
function seedInputs(gridDeviceSystemId?: number) {
  return {
    capabilities: caps("solar/power", "load/power", "grid/power"),
    aggregate: false,
    gridDeviceSystemId,
  };
}

function mapped(handles: number[]): Map<number, any> {
  return new Map(
    handles.map((handle) => {
      const deviceId: DeviceId = Device.generate();
      return [
        handle,
        { deviceId, uuid: Device.toUuid(deviceId), rid: handle, handle },
      ];
    }),
  );
}

describe("authoritative config-v4 seeds", () => {
  beforeEach(() => {
    mockInputs.mockReset();
    mockMappings.mockReset();
  });

  it("preview and persistence keep the same real device refs", async () => {
    const areaId = newUuidV7();
    mockInputs.mockResolvedValue(seedInputs(12));
    const mappings = mapped([12]);
    mockMappings.mockResolvedValue(mappings);

    const [doc, group] = await Promise.all([
      buildPersistableSeedDoc(areaId, 1000001),
      buildSeedGroupPreview(areaId, 1000001),
    ]);

    expect(validateDocV4(doc).valid).toBe(true);
    expect(collectRefs(doc)).toEqual({
      areas: [Area.encode(areaId)],
      devices: [mappings.get(12)!.deviceId],
    });
    // Ids stripped from both sides: these are two SEPARATE documents, and a node id is only
    // meaningful within the document that minted it (they are random, so the preview's ids and the
    // persisted doc's ids differ by construction). What must match is the structure and the refs.
    expect(stripNodeIds(group)).toEqual(stripNodeIds(doc.root.children[0]));
    expect(mockMappings).toHaveBeenCalledWith([12]);
  });

  it("fails explicitly rather than fabricating an unmapped device", async () => {
    const areaId = newUuidV7();
    mockInputs.mockResolvedValue(seedInputs(12));
    mockMappings.mockResolvedValue(new Map());
    await expect(buildPersistableSeedDoc(areaId, 1000001)).rejects.toEqual(
      expect.objectContaining({
        name: "MissingDeviceMappingError",
        handles: [12],
      }),
    );
  });

  it("skips the device lookup entirely for an area with no grid context", async () => {
    const areaId = newUuidV7();
    mockInputs.mockResolvedValue(seedInputs(undefined));

    const doc = await buildPersistableSeedDoc(areaId, 1000001);

    expect(validateDocV4(doc).valid).toBe(true);
    expect(collectRefs(doc)).toEqual({
      areas: [Area.encode(areaId)],
      devices: [],
    });
    expect(mockMappings).not.toHaveBeenCalled();
  });

  it("binds the seed group to the area and never widens scope (§8.3)", async () => {
    const areaId = newUuidV7();
    mockInputs.mockResolvedValue(seedInputs(undefined));

    const group = await buildSeedGroupPreview(areaId, 1000001);

    expect(group.area).toBe(Area.encode(areaId));
    expect(group.heading).toBe(true);
    // Every scope ref lives in the envelope: no child re-binds an area.
    for (const child of group.children) expect(child.area).toBeUndefined();
  });
});
