/**
 * Resolve the Area that represents a logical system. An Area is located by its integer addressing
 * handle: a single-device Area wraps one physical device (handle == its `devices.rid`); a multi-device
 * Area draws its points across child devices via `area_bindings` (the handle names no device of its
 * own — resolved as an area view by `DeviceConfigRegistry.viewableByHandle`). The single-vs-multi
 * distinction is structural (membership), not a stored `kind`.
 *
 * ⚠️ **The handle map is `legacy_handles`, NOT `areas.legacy_system_id`** (config-v4 Phase 13 PR 5).
 * Both area write paths (`createArea`, `DeviceWriter.ensureAreaOfOne`) fill `legacy_handles` inside
 * the area's own transaction, `legacy_handles.area_id` carries a partial UNIQUE index
 * (`legacy_handles_area_unique`) so the mapping is 1:1 exactly as the dropped
 * `areas_legacy_system_unique` was, and it is the table that OUTLIVES the column (PR 6 drops it).
 * Verified 22/22 areas agreeing on `liveone-dev` before the swap — the same proof
 * `lib/registry/device-config.ts:fetchAreaForHandle` ran for its own leg.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { legacyHandles } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";

export interface ResolvedArea {
  id: string;
}

/** The Area the handle `systemId` names, per `legacy_handles`, or null when it names no Area. */
export async function getAreaForSystem(
  systemId: number,
): Promise<ResolvedArea | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ areaId: legacyHandles.areaId })
    .from(legacyHandles)
    .where(eq(legacyHandles.handle, systemId))
    .limit(1);
  // A handle row can exist naming ONLY a device (`area_id IS NULL`) — that is not an Area hit.
  if (!row?.areaId) return null;
  return { id: row.areaId };
}

/**
 * The integer addressing handle for an Area uuid — the inverse of `getAreaForSystem`. For an
 * area-of-one this is the physical device's `rid`; for a multi-device area it is the areas-backed
 * virtual-system handle that `getActivePointsForSystem` resolves to child points. Returns null when
 * the uuid is unknown or the Area carries no handle. Used to map a dashboard's per-card Areas back to
 * the systemIds its share scope authorizes.
 *
 * Equivalent to `DeviceRegistry.handleForArea`, but takes a RAW uuid: areas invert the TypeID seam
 * (raw uuid internal, `ar_…` only at the wire), so routing through the codec would mean an
 * encode-then-decode round-trip for every caller.
 */
export async function getLegacySystemIdForArea(
  areaId: string,
): Promise<number | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ handle: legacyHandles.handle })
    .from(legacyHandles)
    .where(eq(legacyHandles.areaId, areaId))
    .limit(1);
  return row?.handle ?? null;
}
