/**
 * Shared function to fetch admin areas data (server-side rendering + API).
 *
 * Areas are the SEMANTIC layer: an Area is a grouping of 1..N **member devices** (`area_members`). A
 * single-device Area wraps one physical device; a multi-device Area draws points from several (the
 * former vendor_type='composite' fake devices, now areas-backed virtual devices). Membership is read
 * uniformly from `area_members` — there is no `kind` branch. This powers /admin/areas (all areas)
 * and the owner-facing /areas page (the caller's own active areas).
 */

import { clerkClient } from "@clerk/nextjs/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  areaBindings,
  legacyHandles,
} from "@/lib/db/planetscale/schema";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { DeviceRegistry } from "@/lib/registry";
import type { AreaLocation } from "@/lib/areas/types";
import { Area } from "@/lib/ids";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

export interface AreaSourceDevice {
  id: number;
  alias: string | null;
  displayName: string | null;
}

export interface AdminAreaData {
  /** The opaque `ar_` TypeID — the area builder round-trips this verbatim (create/edit/delete). */
  id: string;
  displayName: string;
  alias: string | null;
  legacySystemId: number | null;
  status: string;
  displayTimezone: string;
  timezoneOffsetMin: number;
  location: AreaLocation | null;
  owner: {
    clerkId: string | null;
    email: string | null;
    userName: string | null;
  };
  /** Number of `area_bindings` (role→point overrides). 0 for a plain membership-only Area. */
  bindingCount: number;
  /** The Area's member devices (from `area_members`); length 1 = single-device, >1 = multi-device. */
  memberDevices: AreaSourceDevice[];
}

export interface AdminAreasResult {
  success: true;
  areas: AdminAreaData[];
  totalAreas: number;
  timestamp: string;
}

/** Resolve a physical device handle to its display fields (null if no such device). */
async function resolveDevice(
  systemId: number,
): Promise<AreaSourceDevice | null> {
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  if (!device) return null;
  return {
    id: device.id,
    alias: device.alias,
    displayName: device.displayName,
  };
}

/**
 * Shape a set of already-selected `areas` rows into full `AdminAreaData` — the expensive part
 * (binding counts, Clerk owner batch-fetch, member-device resolution). Shared by the global admin
 * view and the owner-scoped `/areas` view so the shaping lives in exactly one place.
 */
async function shapeAreas(
  allAreas: (typeof areas.$inferSelect)[],
): Promise<AdminAreaData[]> {
  const db = requirePlanetscaleDb();

  // Binding counts per area (one grouped query).
  const bindingCountRows = await db
    .select({
      areaId: areaBindings.areaId,
      count: sql<number>`count(*)::int`,
    })
    .from(areaBindings)
    .groupBy(areaBindings.areaId);
  const bindingCounts = new Map<string, number>(
    bindingCountRows.map((r) => [r.areaId, r.count]),
  );

  // The integer addressing handle per area, from `legacy_handles` — one batched query rather than a join,
  // so neither caller's `select().from(areas)` has to change shape.
  //
  // ⚠️ config-v4 Phase 13 PR 6: this used to read `areas.legacy_system_id` off the row, and it is the ONE
  // live reader of that column PR 5's sweep missed. It was caught here only because dropping the field
  // from `schema.ts` made it a type error — the projection-less `select()` above would otherwise have gone
  // on compiling and started returning `undefined` for every area's handle the moment 0052 applied.
  const handleRows =
    allAreas.length === 0
      ? []
      : await db
          .select({
            areaId: legacyHandles.areaId,
            handle: legacyHandles.handle,
          })
          .from(legacyHandles)
          .where(
            inArray(
              legacyHandles.areaId,
              allAreas.map((a) => a.id),
            ),
          );
  const handleByArea = new Map<string, number>(
    handleRows.flatMap((r) => (r.areaId == null ? [] : [[r.areaId, r.handle]])),
  );

  // Batch-fetch owner info from Clerk.
  const ownerIds = [
    ...new Set(
      allAreas
        .map((a) => a.ownerUserId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const userCache = new Map<
    string,
    { email: string | null; userName: string | null }
  >();
  if (ownerIds.length > 0) {
    const clerk = await clerkClient();
    await Promise.all(
      ownerIds.map(async (id) => {
        try {
          const user = await clerk.users.getUser(id);
          userCache.set(id, {
            email: user.emailAddresses[0]?.emailAddress || null,
            userName: user.username || null,
          });
        } catch (error) {
          console.warn(`[shapeAreas] Failed to fetch user ${id}:`, error);
          userCache.set(id, { email: null, userName: null });
        }
      }),
    );
  }

  const areasData: AdminAreaData[] = [];

  for (const area of allAreas) {
    const userInfo = area.ownerUserId ? userCache.get(area.ownerUserId) : null;

    // Uniform: an Area's member devices are its `area_members` rows — no single-vs-multi branch.
    // `resolveDevice` is int-keyed, so the uuid membership converts back; the `!` is safe by the
    // `area_members.device_id` FK.
    const memberDeviceIds = await getAreaMemberDeviceIds(area.id);
    const memberRids = await DeviceRegistry.ridsForDevices(memberDeviceIds);
    const memberIds = memberDeviceIds.map((id) => memberRids.get(id)!);
    const memberDevices: AreaSourceDevice[] = (
      await Promise.all(
        memberIds.map(
          async (id) =>
            (await resolveDevice(id)) ?? {
              id,
              alias: null,
              displayName: null,
            },
        ),
      )
    ).sort((a, b) => a.id - b.id);

    areasData.push({
      id: Area.encode(area.id),
      displayName: area.name,
      alias: area.slug,
      legacySystemId: handleByArea.get(area.id) ?? null,
      status: area.status,
      displayTimezone: area.displayTimezone,
      timezoneOffsetMin: area.timezoneOffsetMin,
      location: (area.location as AreaLocation | null) ?? null,
      owner: {
        clerkId: area.ownerUserId,
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
      },
      bindingCount: bindingCounts.get(area.id) ?? 0,
      memberDevices,
    });
  }

  return areasData;
}

/** Every Area (admin view — all owners, includes archived). Powers `/admin/areas`. */
export async function getAdminAreasData(): Promise<AdminAreasResult> {
  const db = requirePlanetscaleDb();
  const allAreas = await db.select().from(areas).orderBy(areas.name);
  const areasData = await shapeAreas(allAreas);
  return {
    success: true,
    areas: areasData,
    totalAreas: areasData.length,
    timestamp: new Date().toISOString(),
  };
}

/** The active Areas a single owner owns. Powers the owner-facing `/areas` page. */
export async function getOwnerAreasData(
  userId: string,
): Promise<AdminAreasResult> {
  const db = requirePlanetscaleDb();
  const allAreas = await db
    .select()
    .from(areas)
    .where(and(eq(areas.ownerUserId, userId), eq(areas.status, "active")))
    .orderBy(areas.name);
  const areasData = await shapeAreas(allAreas);
  return {
    success: true,
    areas: areasData,
    totalAreas: areasData.length,
    timestamp: new Date().toISOString(),
  };
}
