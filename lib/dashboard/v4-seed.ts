/**
 * Config-v4 seed builders — capability-derived v3 strategy rewritten with authoritative area/device
 * identities. Preview and persistence intentionally share the exact same resolver.
 */
import { DeviceRegistry } from "@/lib/registry";
import { buildAreaStrategyForHandle } from "@/lib/capabilities/server";
import { rewriteV3ToV4, pureAreaRef, type LegacyRefResolver } from "./v3-to-v4";
import type { DashboardV3 } from "./v3";
import type { DashboardV4, GroupNode } from "./v4";

export class MissingDeviceMappingError extends Error {
  constructor(public readonly handles: number[]) {
    super(`Missing stable device mapping for system(s): ${handles.join(", ")}`);
    this.name = "MissingDeviceMappingError";
  }
}

function devicePins(v3: DashboardV3): number[] {
  const pins = new Set<number>();
  for (const section of v3.sections) {
    for (const card of section.cards) {
      if (card.deviceSystemId != null) pins.add(card.deviceSystemId);
      for (const tile of card.tiles ?? []) {
        if (tile.deviceSystemId != null) pins.add(tile.deviceSystemId);
      }
    }
  }
  return [...pins];
}

async function buildSeedDoc(
  areaUuid: string,
  handle: number,
): Promise<DashboardV4> {
  const v3 = await buildAreaStrategyForHandle(areaUuid, handle);
  const pins = devicePins(v3);
  const mapped = await DeviceRegistry.addrsForHandles(pins);
  const missing = pins.filter((pin) => !mapped.has(pin));
  if (missing.length > 0) throw new MissingDeviceMappingError(missing);
  const resolver: LegacyRefResolver = {
    areaRef: pureAreaRef,
    deviceRef: (legacyHandle) => {
      const device = mapped.get(legacyHandle);
      if (!device) throw new MissingDeviceMappingError([legacyHandle]);
      return device.deviceId;
    },
  };
  return rewriteV3ToV4(v3, resolver);
}

export async function buildSeedGroupPreview(
  areaUuid: string,
  handle: number,
): Promise<GroupNode> {
  const doc = await buildSeedDoc(areaUuid, handle);
  return doc.root.children[0] as GroupNode;
}

export async function buildPersistableSeedDoc(
  areaUuid: string,
  handle: number,
): Promise<DashboardV4> {
  return buildSeedDoc(areaUuid, handle);
}
