/**
 * Persistence for per-user, per-system dashboard descriptors (P2). Backed by the `dashboards`
 * table; absent row → the dashboard is auto-generated from buildDefaultDescriptor.
 */

import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboards } from "@/lib/db/planetscale/schema";
import type { DashboardDescriptor } from "./descriptor";
import { buildDefaultDescriptor } from "./descriptor";
import { getAreaForSystem } from "@/lib/areas/resolve";
import type { LatestPointValues } from "@/lib/types/api";

export async function getSavedDescriptor(
  clerkUserId: string,
  systemId: number,
): Promise<DashboardDescriptor | null> {
  const rows = await requirePlanetscaleDb()
    .select({ descriptor: dashboards.descriptor })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.clerkUserId, clerkUserId),
        eq(dashboards.systemId, systemId),
      ),
    )
    .limit(1);
  return rows[0]?.descriptor
    ? (rows[0].descriptor as DashboardDescriptor)
    : null;
}

export async function saveDescriptor(
  clerkUserId: string,
  systemId: number,
  descriptor: DashboardDescriptor,
  areaId?: string | null,
): Promise<void> {
  await requirePlanetscaleDb()
    .insert(dashboards)
    .values({ clerkUserId, systemId, descriptor, areaId: areaId ?? null })
    .onConflictDoUpdate({
      target: [dashboards.clerkUserId, dashboards.systemId],
      // COALESCE so a flag-off save (areaId null) never wipes a previously-resolved area_id.
      set: {
        descriptor,
        areaId: sql`COALESCE(excluded.area_id, ${dashboards.areaId})`,
        updatedAt: new Date(),
      },
    });
}

/** A dashboard row by its id (the target of a dashboard share token). */
export async function getDashboardById(id: number): Promise<{
  id: number;
  systemId: number;
  areaId: string | null;
  descriptor: DashboardDescriptor;
} | null> {
  const rows = await requirePlanetscaleDb()
    .select({
      id: dashboards.id,
      systemId: dashboards.systemId,
      areaId: dashboards.areaId,
      descriptor: dashboards.descriptor,
    })
    .from(dashboards)
    .where(eq(dashboards.id, id))
    .limit(1);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        systemId: r.systemId,
        areaId: r.areaId,
        descriptor: r.descriptor as DashboardDescriptor,
      }
    : null;
}

/** The id of the caller's dashboard for `systemId`, or null if they haven't saved one yet. */
export async function getDashboardIdForUserSystem(
  clerkUserId: string,
  systemId: number,
): Promise<number | null> {
  const rows = await requirePlanetscaleDb()
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.clerkUserId, clerkUserId),
        eq(dashboards.systemId, systemId),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * The id of the caller's dashboard for `systemId`, creating a default row if none exists yet (so a
 * share token always has a stable target even for an un-customized dashboard). The default descriptor
 * is built server-side from the vendor type (buildDefaultDescriptor ignores `latest`).
 */
export async function getOrCreateDefaultDashboardId(
  clerkUserId: string,
  systemId: number,
  vendorType: string,
): Promise<number> {
  const existingId = await getDashboardIdForUserSystem(clerkUserId, systemId);
  if (existingId !== null) return existingId;

  const descriptor = buildDefaultDescriptor(
    { vendorType },
    {} as LatestPointValues,
  );
  const areaId = (await getAreaForSystem(systemId))?.id ?? null;
  const [row] = await requirePlanetscaleDb()
    .insert(dashboards)
    .values({ clerkUserId, systemId, areaId, descriptor })
    .returning({ id: dashboards.id });
  return row.id;
}

/** Reset to default = drop the saved row. */
export async function deleteDescriptor(
  clerkUserId: string,
  systemId: number,
): Promise<void> {
  await requirePlanetscaleDb()
    .delete(dashboards)
    .where(
      and(
        eq(dashboards.clerkUserId, clerkUserId),
        eq(dashboards.systemId, systemId),
      ),
    );
}
