/**
 * The DB reads behind the `/api/v4/areas/{id}` aggregate's `members` and `bindings` collections.
 *
 * They live here, rather than inline in the GET handler, because clean-sheet §9.2 makes every
 * collection `PUT` return **the new state** — so `PUT …/members` and `PUT …/bindings` must emit the
 * exact shape the aggregate `GET` emits, or a client that writes-then-renders sees a different payload
 * from one that reads-then-renders. Two hand-written projections would drift on the first field added
 * to either; one loader per collection cannot.
 *
 * Both return the pre-serialization shape (`AreaDetailSource`'s member/binding entries) — raw uuids and
 * int-keyed capability lookups still — and `lib/areas/v4-shapes.ts` remains the sole place the TypeIDs
 * are minted.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, devices } from "@/lib/db/planetscale/schema";
import { capabilitiesForDevice } from "@/lib/capabilities/server";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { DeviceRegistry } from "@/lib/registry";
import type { AreaDetailSource } from "@/lib/areas/v4-shapes";

/**
 * An area's members, in membership order, each with its own capability set.
 *
 * Membership arrives as device ids (slice H), so the `dv_` TypeIDs come straight off the membership
 * rows — no `legacy_handles` round trip, and no `device-mapping-incomplete` 503, since
 * `area_members.device_id` FKs `devices.id`. The rid hop remains only because `devices`' config columns
 * and `capabilitiesForDevice` are still int-keyed (Phase 13 removes it).
 */
export async function loadAreaMembers(
  areaUuid: string,
): Promise<AreaDetailSource["members"]> {
  const db = requirePlanetscaleDb();
  const memberIds = await getAreaMemberDeviceIds(areaUuid);
  if (memberIds.length === 0) return [];
  const memberRids = await DeviceRegistry.ridsForDevices(memberIds);
  const memberRows = await db
    .select({
      id: devices.rid,
      name: devices.name,
      vendor: devices.vendor,
      status: devices.status,
    })
    .from(devices)
    .where(inArray(devices.rid, [...memberRids.values()]));
  const memberById = new Map(memberRows.map((member) => [member.id, member]));
  return Promise.all(
    memberIds.map(async (deviceId) => {
      const rid = memberRids.get(deviceId)!;
      const member = memberById.get(rid);
      if (!member) throw new Error(`Area member system not found: ${rid}`);
      const capabilities = await capabilitiesForDevice(rid);
      return {
        id: deviceId,
        name: member.name,
        vendor: member.vendor,
        status: member.status,
        capabilities: [...capabilities].sort(),
      };
    }),
  );
}

/**
 * An area's bindings in the aggregate's canonical order (role, metric, priority, id).
 *
 * NOT `getAreaBindingsForEditor`'s order (plain `ordinal`) and NOT its projection: this one carries the
 * binding's own identity (`bn_`) and its slot `priority`, which the v4 wire states and the legacy
 * editor payload never did. `area_bindings` holds the point uuid itself (`point_uid`, NOT NULL since
 * 0047), so no `points` join is needed.
 */
export async function loadAreaBindings(
  areaUuid: string,
): Promise<AreaDetailSource["bindings"]> {
  return requirePlanetscaleDb()
    .select({
      id: areaBindings.id,
      role: areaBindings.role,
      metricType: areaBindings.metricType,
      pointUid: areaBindings.pointUid,
      priority: areaBindings.priority,
      transform: areaBindings.transform,
    })
    .from(areaBindings)
    .where(eq(areaBindings.areaId, areaUuid))
    .orderBy(
      asc(areaBindings.role),
      asc(areaBindings.metricType),
      asc(areaBindings.priority),
      asc(areaBindings.id),
    );
}
