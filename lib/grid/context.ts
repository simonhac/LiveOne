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
 *
 * 🛑 **A REAL DEVICE, and only a real device.** It joins `points → devices` on `devices.rid`, so a
 * handle with no `devices` row — a synthetic AREA handle (≥ 1,000,000), or a legacy area handle
 * like 7 (Craig Unified) or 8 (Kinkora Unified) — matches nothing and returns false.
 *
 * That makes the AREA branch of {@link resolveGridContextForDevice} unreachable in practice, and it
 * has been so since before the device→0..1-area change: an area resolves its location fine and then
 * fails here. Measured on `liveone-dev` 2026-09-14 — every one of handles 7, 8, 1000001, 1000002
 * and 1000003 resolves a NEM region and then answers `grid-signals: false`, so the Local Grid card
 * has never rendered on an area-addressed dashboard. Pre-existing and deliberately NOT fixed here:
 * turning it on is a visible product change and belongs with
 * `docs/plans/20260914-naming-bindings-and-area-settings.md` (Unit 2), which deletes this resolution path.
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
    //    property, so a device in no Area has no grid card.
    //
    // Two queries at worst, one in the common case: a device handle resolves its area in the same
    // statement, an area handle costs a second. (Steps d and e below add their own.)
    //
    // 🛑 **DEVICE-FIRST, through `devices.area_id`** — the same precedence `lib/dashboard/subject.ts`
    // locks, and the same edge every other reader moved to. It used to resolve a device handle
    // through `legacy_handles.handle → area_id`, i.e. the eagerly-minted AREA-OF-ONE, and that broke
    // twice over once the mint stopped:
    //
    //   - a NEWLY onboarded device has no `legacy_handles` area leg at all (the writer stopped
    //     claiming one — an area it is placed in already owns a handle), so this returned null and
    //     the device silently lost `grid-signals` and its Local Grid card;
    //   - a RE-HOMED device resolved its shell's location rather than its site's, which is the same
    //     wrong-area class the whole 0..1 change exists to close.
    //
    // The `legacy_handles` leg survives for the OTHER kind of handle: a synthetic AREA handle
    // (≥ 1,000,000) names no device, and that is still how it finds its area.
    //
    // An AMBIENT device (`area_id IS NULL`) returns null HERE rather than falling through to the
    // handle leg — falling through would resurrect the shell's location for a device deliberately
    // placed nowhere.
    //
    // ⚠️ A handle that names BOTH a device and an area resolves the DEVICE's area, which is the
    // locked `?systemId=N` precedence (`lib/dashboard/subject.ts`) and is what every other part of
    // `resolveDeviceCapabilities` already does for the same handle — `getActivePointsForDevice` is
    // device-first too. Before this change grid-signals was the lone area-first reader, so a
    // colliding handle disagreed with its own point set. The residual ambiguity is the integer
    // handle itself; `docs/plans/retire-the-integer-handle.md` is the fix. No handle on prod or dev
    // currently names a device and an area that differ.
    let location: AreaLocation | null;
    const [byDevice] = await db
      .select({ areaId: devices.areaId, location: areas.location })
      .from(devices)
      .leftJoin(areas, eq(areas.id, devices.areaId))
      .where(eq(devices.rid, systemId))
      .limit(1);
    if (byDevice) {
      if (!byDevice.areaId) return null;
      location = (byDevice.location ?? null) as AreaLocation | null;
    } else {
      const [byHandle] = await db
        .select({ location: areas.location })
        .from(areas)
        .innerJoin(legacyHandles, eq(legacyHandles.areaId, areas.id))
        .where(eq(legacyHandles.handle, systemId))
        .limit(1);
      if (!byHandle) return null;
      location = (byHandle.location ?? null) as AreaLocation | null;
    }

    // c. Derive the NEM region; null means off-NEM (e.g. WA/NT or no usable location).
    const region = nemRegionForLocation(location);
    if (!region) return null;

    // d. Grid-connected check: the device must play the grid role.
    //
    // ⚠️ This comment used to say "a multi-device area has no own points — its grid role is a
    // binding to a child device's grid point — so check its bindings". `devicePlaysGridRole` does
    // not check bindings and never has; see its docstring for the measurement. The claim is removed
    // rather than made true because doing so would newly enable the card on every area dashboard.
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
