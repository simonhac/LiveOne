/**
 * Viewer-scoped and trusted device resolvers for config-v4 dashboard refs.
 *
 * Public identity comes from `legacy_handles.device_id`; data still addresses the current system
 * through its integer handle until the devices table lands at cutover.
 */
import { eq, inArray, isNull, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices } from "@/lib/db/planetscale/schema";
import { DeviceRegistry } from "@/lib/registry";
import type { DeviceId } from "@/lib/ids";

export interface ReadableDevice {
  id: DeviceId;
  name: string;
  systemId: number;
  vendor: string;
  status: string;
}

/**
 * Devices this user may read: owned, or ownerless-and-therefore-public. A third `user_systems` viewer
 * grant term was dropped with that table in migration 0045 (slice F) — the grant-based read path is
 * now `requireDashboardAccess`/`grantedSystemScopeForUser`, and this function's callers
 * (app/dashboard/[...slug]/page.tsx, lib/dashboard/v4-routes.ts) pass the DASHBOARD OWNER's id, for
 * whom ownership is the operative term.
 */
export async function listReadableDevices(
  userId: string,
): Promise<ReadableDevice[]> {
  // config-v4 slice K2: the config columns come from `devices` (rid/name/vendor/status). The
  // `DeviceRegistry.addrsForHandles` hop below is deliberately KEPT even though `devices.id` is right
  // here: `legacy_handles` is what makes a device PUBLICLY addressable, so a device without one is
  // filtered out today. Deriving the id from `devices.id` instead would silently WIDEN this list, and
  // this is an authorization surface — identity semantics change on their own PR, not in a read swap.
  const visible = await requirePlanetscaleDb()
    .select({
      id: devices.rid,
      displayName: devices.name,
      vendorType: devices.vendor,
      status: devices.status,
    })
    .from(devices)
    .where(or(eq(devices.ownerUserId, userId), isNull(devices.ownerUserId)));
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
      id: devices.rid,
      name: devices.name,
      vendor: devices.vendor,
      status: devices.status,
    })
    .from(devices)
    .where(inArray(devices.rid, handles));
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
