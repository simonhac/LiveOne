/**
 * Helper-device `vendorSiteId` scheme — pure and client-safe (no db/server imports). An Area's
 * helper device is minted with `helper:area:<areaId>` (lib/areas/helper.ts); mint and parse both
 * go through here so the two directions can never drift.
 */

/** Loose uuid shape: exactly 36 hex/dash chars (we don't re-validate group layout here). */
const HELPER_SITE_ID_RE = /^helper:area:([0-9a-fA-F-]{36})$/;

/** The canonical `vendorSiteId` for an Area's helper device. */
export function helperSiteId(areaId: string): string {
  return `helper:area:${areaId}`;
}

/** Inverse of {@link helperSiteId}: the parent Area's id, or null for a non-helper site id. */
export function parentAreaIdFromHelperSiteId(
  vendorSiteId: string,
): string | null {
  const m = HELPER_SITE_ID_RE.exec(vendorSiteId);
  return m ? m[1] : null;
}
