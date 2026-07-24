/**
 * Viewer-scoped and trusted device resolvers for config-v4 dashboard refs.
 *
 * Public identity comes from `legacy_handles.device_id`; data still addresses the current system
 * through its integer handle until the devices table lands at cutover.
 */
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems, userSystems } from "@/lib/db/planetscale/schema";
import { DeviceRegistry } from "@/lib/registry";
import type { DeviceId } from "@/lib/ids";

export interface ReadableDevice {
  id: DeviceId;
  name: string;
  systemId: number;
  vendor: string;
  status: string;
}

export async function listReadableDevices(
  userId: string,
): Promise<ReadableDevice[]> {
  const visible = await requirePlanetscaleDb()
    .select({
      id: systems.id,
      displayName: systems.displayName,
      vendorType: systems.vendorType,
      status: systems.status,
    })
    .from(systems)
    .leftJoin(
      userSystems,
      and(
        eq(userSystems.systemId, systems.id),
        eq(userSystems.clerkUserId, userId),
      ),
    )
    .where(
      or(
        eq(systems.ownerClerkUserId, userId),
        isNull(systems.ownerClerkUserId),
        isNotNull(userSystems.clerkUserId),
      ),
    );
  const mappings = await DeviceRegistry.addrsForHandles(
    visible.map((s) => s.id),
  );
  return visible.flatMap((s) => {
    const mapped = mappings.get(s.id);
    return mapped
      ? [
          {
            id: mapped.deviceId,
            name: s.displayName,
            systemId: s.id,
            vendor: s.vendorType,
            status: s.status,
          },
        ]
      : [];
  });
}

/**
 * Resolve an already-authorized set of device refs (share/grant render path). No viewer filtering:
 * the caller's dashboard scope is the authorization boundary.
 */
export async function resolveDevicesByIds(
  ids: DeviceId[],
): Promise<ReadableDevice[]> {
  const unique = [...new Set(ids)];
  const mappings = await DeviceRegistry.addrsForDevices(unique);
  const handles = [...mappings.values()].map((m) => m.handle);
  if (handles.length === 0) return [];
  const rows = await requirePlanetscaleDb()
    .select({
      id: systems.id,
      name: systems.displayName,
      vendor: systems.vendorType,
      status: systems.status,
    })
    .from(systems)
    .where(inArray(systems.id, handles));
  const systemsById = new Map(rows.map((r) => [r.id, r]));
  return unique.flatMap((id) => {
    const mapped = mappings.get(id);
    const row = mapped ? systemsById.get(mapped.handle) : undefined;
    return mapped && row
      ? [
          {
            id,
            name: row.name,
            systemId: row.id,
            vendor: row.vendor,
            status: row.status,
          },
        ]
      : [];
  });
}
