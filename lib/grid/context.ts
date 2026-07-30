/**
 * Resolve the grid-signals context for a dashboard's system: the NEM region the device's identity
 * Area sits in, and the public OpenElectricity device that serves that region's live signals.
 *
 * The card it backs reads a DIFFERENT (public OE region) device than the dashboard it lives on, so
 * this is the cross-device seam. Returns null whenever the card should not render: no Area, no
 * derivable region, the device is off-grid (no `bidi.grid*` point), or no public OE device exists
 * for the region. See docs/architecture/areas-and-dashboards.md.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { AreaLocation } from "@/lib/areas/types";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices,
  areas,
  legacyHandles,
  points,
} from "@/lib/db/planetscale/schema";
import { stemMatchesRole } from "@/lib/roles/registry";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";

import type { GridContext } from "@/lib/grid/types";

/**
 * Whether a device plays the grid role — a real device checks its own `bidi.grid*` points. Returns
 * false for off-grid systems.
 */
async function devicePlaysGridRole(
  db: ReturnType<typeof requirePlanetscaleDb>,
  systemId: number,
): Promise<boolean> {
  const gridPoints = await db
    .select({ logicalPathStem: points.logicalPath })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(eq(devices.rid, systemId));
  return gridPoints.some(
    (p) =>
      p.logicalPathStem != null && stemMatchesRole(p.logicalPathStem, "grid"),
  );
}

export async function resolveGridContextForDevice(
  systemId: number,
): Promise<GridContext | null> {
  // This runs inline on the dashboard server render. It is a gated, additive feature, so any DB
  // fault must degrade to "no grid card" — never 500 the whole dashboard for a user who may have
  // nothing to do with the grid signals. Hence the catch-all below.
  try {
    const db = requirePlanetscaleDb();

    // b. The Area for this handle carries the location we derive the region from — a multi-device site
    //    ("Kinkora Unified") or a genuine single-device Area (e.g. "Kutis"). Location is an Area-only
    //    property (areas are explicit — no area-of-one), so a bare device with no Area has no grid card.
    // config-v4 Phase 13 PR 5: located via `legacy_handles`, not the dropped
    // `areas.legacy_system_id`. INNER join — the old predicate could not match a NULL handle either,
    // and a miss still degrades to "no grid card" via the `!area` return below.
    const [area] = await db
      .select({ location: areas.location })
      .from(areas)
      .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
      .where(eq(legacyHandles.handle, systemId))
      .limit(1);
    if (!area) return null;

    const location = (area.location ?? null) as AreaLocation | null;

    // c. Derive the NEM region; null means off-NEM (e.g. WA/NT or no usable location).
    const region = nemRegionForLocation(location);
    if (!region) return null;

    // d. Grid-connected check: the device must play the grid role. A multi-device area has no own
    //    point_info — its grid role is a binding to a child device's grid point — so check its
    //    bindings; a single device checks its own points. Off-grid devices have neither.
    const hasGridPoint = await devicePlaysGridRole(db, systemId);
    if (!hasGridPoint) return null;

    // e. Resolve the public OpenElectricity device serving this region.
    const [oeDevice] = await db
      .select({ id: devices.rid })
      .from(devices)
      .where(
        and(
          eq(devices.vendor, "openelectricity"),
          eq(devices.vendorSiteId, region),
          isNull(devices.ownerUserId),
          eq(devices.status, "active"),
        ),
      )
      .limit(1);
    if (!oeDevice) {
      // Region derived but no public OE device seeded for it — the card silently can't render.
      // Surface it so the gap is observable (seed via scripts/openelectricity/seed-devices.ts).
      console.warn(
        `[grid-context] system ${systemId} is in NEM region ${region} but no public ` +
          `OpenElectricity system is seeded for it — Local Grid card hidden.`,
      );
      return null;
    }

    return { region, regionSystemId: oeDevice.id };
  } catch (err) {
    console.error(
      `[grid-context] failed to resolve grid context for system ${systemId}; hiding card.`,
      err,
    );
    return null;
  }
}
