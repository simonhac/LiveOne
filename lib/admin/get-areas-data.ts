/**
 * Shared function to fetch admin areas data (server-side rendering + API).
 *
 * Areas are the SEMANTIC layer: an Area is a grouping of 1..N **member devices** (`area_devices`). A
 * single-device Area wraps one physical system; a multi-device Area draws points from several (the
 * former vendor_type='composite' fake systems, now areas-backed virtual systems). Membership is read
 * uniformly from `area_devices` — there is no `kind` branch. This powers /admin/areas (all areas)
 * and the owner-facing /areas page (the caller's own active areas).
 */

import { clerkClient } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { getAreaDeviceSystemIds } from "@/lib/areas/devices";
import type { AreaLocation } from "@/lib/areas/types";

export interface AreaSourceSystem {
  id: number;
  alias: string | null;
  displayName: string | null;
}

export interface AdminAreaData {
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
  /** The Area's member devices (from `area_devices`); length 1 = single-device, >1 = multi-device. */
  memberSystems: AreaSourceSystem[];
}

export interface AdminAreasResult {
  success: true;
  areas: AdminAreaData[];
  totalAreas: number;
  timestamp: string;
}

/** Resolve a physical system id to its display fields (null if no such system). */
async function resolveSystem(
  systemsManager: SystemsManager,
  systemId: number,
): Promise<AreaSourceSystem | null> {
  const system = await systemsManager.getSystem(systemId);
  if (!system) return null;
  return {
    id: system.id,
    alias: system.alias,
    displayName: system.displayName,
  };
}

/**
 * Shape a set of already-selected `areas` rows into full `AdminAreaData` — the expensive part
 * (binding counts, Clerk owner batch-fetch, member-system resolution). Shared by the global admin
 * view and the owner-scoped `/areas` view so the shaping lives in exactly one place.
 */
async function shapeAreas(
  allAreas: (typeof areas.$inferSelect)[],
): Promise<AdminAreaData[]> {
  const db = requirePlanetscaleDb();
  const systemsManager = SystemsManager.getInstance();

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

  // Batch-fetch owner info from Clerk.
  const ownerIds = [
    ...new Set(
      allAreas
        .map((a) => a.ownerClerkUserId)
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
    const userInfo = area.ownerClerkUserId
      ? userCache.get(area.ownerClerkUserId)
      : null;

    // Uniform: an Area's member devices are its `area_devices` rows — no single-vs-multi branch.
    const memberIds = await getAreaDeviceSystemIds(area.id);
    const memberSystems: AreaSourceSystem[] = (
      await Promise.all(
        memberIds.map(
          async (id) =>
            (await resolveSystem(systemsManager, id)) ?? {
              id,
              alias: null,
              displayName: null,
            },
        ),
      )
    ).sort((a, b) => a.id - b.id);

    areasData.push({
      id: area.id,
      displayName: area.displayName,
      alias: area.alias,
      legacySystemId: area.legacySystemId,
      status: area.status,
      displayTimezone: area.displayTimezone,
      timezoneOffsetMin: area.timezoneOffsetMin,
      location: (area.location as AreaLocation | null) ?? null,
      owner: {
        clerkId: area.ownerClerkUserId,
        email: userInfo?.email || null,
        userName: userInfo?.userName || null,
      },
      bindingCount: bindingCounts.get(area.id) ?? 0,
      memberSystems,
    });
  }

  return areasData;
}

/** Every Area (admin view — all owners, includes archived). Powers `/admin/areas`. */
export async function getAdminAreasData(): Promise<AdminAreasResult> {
  const db = requirePlanetscaleDb();
  const allAreas = await db.select().from(areas).orderBy(areas.displayName);
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
    .where(and(eq(areas.ownerClerkUserId, userId), eq(areas.status, "active")))
    .orderBy(areas.displayName);
  const areasData = await shapeAreas(allAreas);
  return {
    success: true,
    areas: areasData,
    totalAreas: areasData.length,
    timestamp: new Date().toISOString(),
  };
}
