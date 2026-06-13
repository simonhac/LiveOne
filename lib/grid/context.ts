/**
 * Resolve the grid-signals context for a dashboard's system: the NEM region the system's identity
 * Area sits in, and the public OpenElectricity system that serves that region's live signals.
 *
 * The card it backs reads a DIFFERENT (public OE region) system than the dashboard it lives on, so
 * this is the cross-system seam. Returns null whenever the card should not render: flags off, no
 * identity Area, no derivable region, the system is off-grid (no `bidi.grid*` point), or no public OE
 * system exists for the region. See docs/architecture/areas-and-dashboards.md.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { AreaLocation } from "@/lib/areas/types";
import { AREAS_TABLE } from "@/lib/areas/flags";
import { GRID_SIGNALS_CARD } from "@/lib/dashboard/flags";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, pointInfo, systems } from "@/lib/db/planetscale/schema";
import { stemMatchesRole } from "@/lib/roles/registry";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";

import type { GridContext } from "@/lib/grid/types";

export async function resolveGridContextForSystem(
  systemId: number,
): Promise<GridContext | null> {
  // a. Both gates must be on.
  if (!GRID_SIGNALS_CARD || !AREAS_TABLE) return null;

  // This runs inline on the dashboard server render. It is a gated, additive feature, so any DB
  // fault must degrade to "no grid card" — never 500 the whole dashboard for a user who may have
  // nothing to do with the grid signals. Hence the catch-all below.
  try {
    const db = requirePlanetscaleDb();

    // b. The identity Area for this system carries the location we derive the region from.
    const [area] = await db
      .select({ location: areas.location })
      .from(areas)
      .where(
        and(eq(areas.legacySystemId, systemId), eq(areas.kind, "identity")),
      )
      .limit(1);
    if (!area) return null;

    const location = (area.location ?? null) as AreaLocation | null;

    // c. Derive the NEM region; null means off-NEM (e.g. WA/NT or no usable location).
    const region = nemRegionForLocation(location);
    if (!region) return null;

    // d. Grid-connected check: the system must play the grid role. Any point whose stem matches the
    //    grid anchor ("bidi.grid" or "bidi.grid.*") makes the system grid-connected; off-grid
    //    systems have none and get no card.
    const gridPoints = await db
      .select({ logicalPathStem: pointInfo.logicalPathStem })
      .from(pointInfo)
      .where(eq(pointInfo.systemId, systemId));

    const hasGridPoint = gridPoints.some(
      (p) =>
        p.logicalPathStem != null && stemMatchesRole(p.logicalPathStem, "grid"),
    );
    if (!hasGridPoint) return null;

    // e. Resolve the public OpenElectricity system serving this region.
    const [oeSystem] = await db
      .select({ id: systems.id })
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, "openelectricity"),
          eq(systems.vendorSiteId, region),
          isNull(systems.ownerClerkUserId),
          eq(systems.status, "active"),
        ),
      )
      .limit(1);
    if (!oeSystem) {
      // Region derived but no public OE system seeded for it — the card silently can't render.
      // Surface it so the gap is observable (seed via scripts/seed-openelectricity-systems.ts).
      console.warn(
        `[grid-context] system ${systemId} is in NEM region ${region} but no public ` +
          `OpenElectricity system is seeded for it — Local Grid card hidden.`,
      );
      return null;
    }

    return { region, regionSystemId: oeSystem.id };
  } catch (err) {
    console.error(
      `[grid-context] failed to resolve grid context for system ${systemId}; hiding card.`,
      err,
    );
    return null;
  }
}
