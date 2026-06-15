/**
 * Shared function to fetch admin areas data (server-side rendering + API).
 *
 * Areas are the SEMANTIC layer (P3): `kind='identity'` wraps a single physical system; `kind='composite'`
 * binds points drawn from ≥2 systems (these are the former vendor_type='composite' fake systems rows,
 * now areas-backed virtual systems — see migration 0014). This powers /admin/areas.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaBindings } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { getCompositeBindingRefs } from "@/lib/areas/bindings";
import type { AreaLocation } from "@/lib/areas/types";

export interface AreaSourceSystem {
  id: number;
  alias: string | null;
  displayName: string | null;
}

export interface AdminAreaData {
  id: string;
  kind: "identity" | "composite";
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
  bindingCount: number;
  /** For identity areas: the single physical system this wraps. */
  sourceSystem: AreaSourceSystem | null;
  /** For composite areas: the physical systems its bindings draw points from. */
  sourceSystems: AreaSourceSystem[];
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

export async function getAdminAreasData(): Promise<AdminAreasResult> {
  const db = requirePlanetscaleDb();
  const systemsManager = SystemsManager.getInstance();

  const allAreas = await db.select().from(areas).orderBy(areas.displayName);

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
          console.warn(
            `[getAdminAreasData] Failed to fetch user ${id}:`,
            error,
          );
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

    let sourceSystem: AreaSourceSystem | null = null;
    let sourceSystems: AreaSourceSystem[] = [];

    if (area.kind === "identity" && area.sourceSystemId != null) {
      sourceSystem = await resolveSystem(systemsManager, area.sourceSystemId);
    } else if (area.kind === "composite" && area.legacySystemId != null) {
      const refs = await getCompositeBindingRefs(area.legacySystemId);
      const seen = new Map<number, AreaSourceSystem>();
      for (const ref of refs) {
        if (seen.has(ref.pointSystemId)) continue;
        const resolved = await resolveSystem(systemsManager, ref.pointSystemId);
        seen.set(
          ref.pointSystemId,
          resolved ?? {
            id: ref.pointSystemId,
            alias: null,
            displayName: null,
          },
        );
      }
      sourceSystems = Array.from(seen.values()).sort((a, b) => a.id - b.id);
    }

    areasData.push({
      id: area.id,
      kind: area.kind as "identity" | "composite",
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
      sourceSystem,
      sourceSystems,
    });
  }

  return {
    success: true,
    areas: areasData,
    totalAreas: areasData.length,
    timestamp: new Date().toISOString(),
  };
}
