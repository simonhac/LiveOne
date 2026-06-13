/**
 * Ownership policy for systems (devices).
 *
 * Most vendors authenticate with PER-USER credentials (Amber API key, Tesla/Enphase OAuth
 * tokens) stored against the system's owner, so those systems MUST have an owner.
 *
 * A few vendors authenticate with an APP-WIDE credential (an env var) instead. Their systems
 * can be OWNERLESS — i.e. **public**: readable by every user, polled without an owner. The
 * app-wide-credential vendors are listed here; everything else requires an owner to poll.
 *
 * Note: a missing `credentialFields` is NOT a reliable signal — Enphase declares none yet still
 * needs an owner (OAuth). Hence this explicit allow-list.
 */
export const APP_CREDENTIAL_VENDOR_TYPES: ReadonlySet<string> = new Set([
  "openelectricity",
]);

/** True if the vendor authenticates app-wide (env), so its systems may be ownerless/public. */
export function vendorUsesAppCredentials(
  vendorType: string | null | undefined,
): boolean {
  if (!vendorType) return false;
  return APP_CREDENTIAL_VENDOR_TYPES.has(vendorType.toLowerCase());
}

/** A system is public when it has no owner. Public systems are readable by everyone. */
export function isPublicSystem(system: {
  ownerClerkUserId: string | null;
}): boolean {
  return system.ownerClerkUserId == null;
}
