/**
 * The Area → integer addressing handle direction of the `legacy_handles` map.
 *
 * ⚠️ **The handle map is `legacy_handles`, NOT `areas.legacy_system_id`** (config-v4 Phase 13 PR 5).
 * Both area write paths (`createArea`, `DeviceWriter.ensureAreaOfOne`) fill `legacy_handles` inside
 * the area's own transaction, `legacy_handles.area_id` carries a partial UNIQUE index
 * (`legacy_handles_area_unique`) so the mapping is 1:1 exactly as the dropped
 * `areas_legacy_system_unique` was, and it is the table that OUTLIVES the column (PR 6 drops it).
 * Verified 22/22 areas agreeing on `liveone-dev` before the swap — the same proof
 * `lib/registry/device-config.ts:fetchAreaForHandle` ran for its own leg.
 *
 * 🛑 **The other direction — handle → Area — is DELETED, deliberately.** `getAreaForDevice` lived
 * here and answered the area leg of a handle *without ever seeing the device leg*, which made every
 * caller built on it structurally incapable of noticing that a handle names both. Its name said
 * "ForDevice"; what it returned was the eagerly-minted area-of-one, which a re-homed device has left.
 * Two callers shipped wrong answers off it before it went. Ask `DeviceConfigRegistry.deviceByHandle`
 * and `areaByHandle` side by side instead — both are per-request memoized, so seeing both legs costs
 * nothing, and the precedence between them becomes a decision the call site makes in the open rather
 * than one this file made silently on its behalf. See `docs/plans/exact-resolution-or-refuse.md`.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { legacyHandles } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";

/**
 * The integer addressing handle for an Area uuid. For an area-of-one this is the physical device's
 * `rid`; for a multi-device area it is the areas-backed virtual-device handle that
 * `getActivePointsForDevice` resolves to child points. Returns null when the uuid is unknown or the
 * Area carries no handle. Used to map a dashboard's per-card Areas back to the systemIds its share
 * scope authorizes.
 *
 * Unambiguous in this direction, which is why it survives: `legacy_handles.area_id` is partial-unique,
 * so one Area has at most one handle. The reverse is not a function — a handle can name two things.
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
