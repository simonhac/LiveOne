/**
 * Persistence for per-user, per-system dashboard descriptors (P2). Backed by the `dashboards`
 * table; absent row → the dashboard is auto-generated from buildDefaultDescriptor.
 */

import { and, eq, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboards } from "@/lib/db/planetscale/schema";
import type { DashboardDescriptor } from "./descriptor";

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
