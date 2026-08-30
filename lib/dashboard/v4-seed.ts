/**
 * Config-v4 seed builders — the capability-derived area strategy, built as v4 and stamped with
 * authoritative area/device identities. Preview and persistence intentionally share the exact same
 * resolution, so a previewed seed is byte-identical to the one that gets saved.
 *
 * `buildAreaStrategy` emits a `GroupNode` natively, so this module's job is just the two IDENTITY
 * hops the pure builder cannot do: the area uuid → `ar_` ref, and the strategy's one device pin
 * (the `oe-grid` card's OE region device) legacy handle → `dv_`.
 */
import { DeviceRegistry } from "@/lib/registry";
import { resolveAreaStrategyInputs } from "@/lib/capabilities/server";
import { buildAreaStrategy } from "@/lib/capabilities/strategy";
import { areaRefToArId } from "@/lib/areas/ref";
import { normalizeDocV4 } from "./v4-validate";
import type { DashboardV4, GroupNode } from "./v4";

export class MissingDeviceMappingError extends Error {
  constructor(public readonly handles: number[]) {
    super(`Missing stable device mapping for system(s): ${handles.join(", ")}`);
    this.name = "MissingDeviceMappingError";
  }
}

async function buildSeedDoc(
  areaUuid: string,
  handle: number,
): Promise<DashboardV4> {
  const inputs = await resolveAreaStrategyInputs(handle);
  const gridHandle = inputs.gridDeviceSystemId;
  // A persisted seed must never carry a fabricated device ref — an unmapped pin is a hard failure
  // (the routes surface it as 503), not a silently-dropped card.
  const gridDevice =
    gridHandle != null
      ? (await DeviceRegistry.addrsForHandles([gridHandle])).get(gridHandle)
          ?.deviceId
      : undefined;
  if (gridHandle != null && !gridDevice) {
    throw new MissingDeviceMappingError([gridHandle]);
  }

  // Dual-accept (raw uuid OR already `ar_`); a seed is machine-built, so neither is a user error.
  const area = areaRefToArId(areaUuid);
  if (!area) throw new TypeError(`not a valid area ref: ${areaUuid}`);

  const group = buildAreaStrategy({
    area,
    capabilities: inputs.capabilities,
    aggregate: inputs.aggregate,
    gridDevice,
  });
  return normalizeDocV4({
    version: 4,
    root: { kind: "group", direction: "column", children: [group] },
  });
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
