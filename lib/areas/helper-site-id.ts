/**
 * Helper-device `vendorSiteId` scheme — pure and client-safe (no db/server imports). An Area's
 * helper device is minted with `helper:area:<areaId>` (lib/areas/helper.ts); mint and parse both
 * go through here so the two directions can never drift.
 *
 * ## The area id in here is the `ar_` TypeID, not a raw uuid
 *
 * 🛑 **This string reaches an ANONYMOUS wire.** `devices.vendor_site_id` is emitted verbatim as
 * `DeviceBlock.vendorSiteId` by `/api/data` (lib/dashboard/serve-data.ts), and `/api/data` is
 * **share-token readable** — so a `?access=` viewer with no account receives it. While the id inside
 * was a raw `areas.id` uuid that was the last raw-uuid leak on the wire.
 *
 * Both legs now speak `ar_`:
 *
 *   * {@link helperSiteId} MINTS `helper:area:ar_…`.
 *   * {@link parentAreaIdFromHelperSiteId} accepts **either** form and always returns the `ar_`
 *     TypeID, so one area yields one answer whichever form it was stored in.
 *
 * ⚠️ **The dual-accept parse is load-bearing and must ship BEFORE the data changes.** This is the
 * ADDITIVE ordering rule, not the drop rule: migration `0053` rewrites the stored rows, and the
 * running build has to already read both forms when it lands. It is also not merely a deploy-window
 * concern — an environment that has not had 0053 applied yet still serves the raw form, so the
 * legacy leg stays until both environments are migrated *and* someone deliberately retires it.
 */
import type { AreaId } from "@/lib/ids";
import { areaRefToArId } from "./ref";

const HELPER_PREFIX = "helper:area:";

/**
 * The canonical `vendorSiteId` for an Area's helper device: `helper:area:ar_…`.
 *
 * Accepts the raw `areas.id` uuid (what every server caller holds) or an `ar_` TypeID. Throws on
 * anything else — a programmer error, and the same contract as `encodeTypeId`; minting a helper whose
 * site id does not name an area would be silently unparseable later.
 */
export function helperSiteId(areaId: string): string {
  const arId = areaRefToArId(areaId);
  if (!arId)
    throw new TypeError(
      `helperSiteId: not an area id: ${JSON.stringify(areaId)}`,
    );
  return `${HELPER_PREFIX}${arId}`;
}

/**
 * Inverse of {@link helperSiteId}: the parent Area's `ar_` id, or null for a non-helper site id.
 *
 * **Dual-accept**: `helper:area:ar_…` (post-0053) and `helper:area:<raw uuid>` (pre-0053) both
 * resolve, to the same `AreaId`.
 */
export function parentAreaIdFromHelperSiteId(
  vendorSiteId: string,
): AreaId | null {
  if (!vendorSiteId.startsWith(HELPER_PREFIX)) return null;
  return areaRefToArId(vendorSiteId.slice(HELPER_PREFIX.length));
}
