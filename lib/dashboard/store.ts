/**
 * Dashboard-row helpers: look up a dashboard by id (share-token target) and lazily mint a default
 * dashboard row for a system so a share token always has a stable target. Descriptors are v3.
 */

import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboards } from "@/lib/db/planetscale/schema";
import { buildDefaultDashboardV3 } from "./v3";
import { getAreaForSystem } from "@/lib/areas/resolve";

/** A dashboard row by its id (the target of a dashboard share token). Descriptor is opaque JSONB. */
export async function getDashboardById(id: number): Promise<{
  id: number;
  systemId: number | null;
  areaId: string | null;
  descriptor: unknown;
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
        descriptor: r.descriptor,
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
 * is a single-section v3 dashboard over the system's identity Area.
 */
export async function getOrCreateDefaultDashboardId(
  clerkUserId: string,
  systemId: number,
  vendorType: string,
): Promise<number> {
  const existingId = await getDashboardIdForUserSystem(clerkUserId, systemId);
  if (existingId !== null) return existingId;

  const areaId = (await getAreaForSystem(systemId))?.id ?? null;
  const descriptor = buildDefaultDashboardV3({
    areaId: areaId ?? `system-${systemId}`,
    vendorType,
  });
  try {
    const [row] = await requirePlanetscaleDb()
      .insert(dashboards)
      .values({ clerkUserId, systemId, areaId, descriptor })
      .returning({ id: dashboards.id });
    return row.id;
  } catch (err) {
    // Two concurrent first-loads of an un-customized system both see no row and both insert; the
    // loser hits the (clerk_user_id, system_id) unique violation. Re-select the row the winner made
    // rather than 500. (Re-throw anything that isn't a 23505 unique violation.)
    if ((err as { code?: string })?.code !== "23505") throw err;
    const raced = await getDashboardIdForUserSystem(clerkUserId, systemId);
    if (raced !== null) return raced;
    throw err;
  }
}
