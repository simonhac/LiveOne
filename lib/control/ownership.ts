/**
 * Ownership — the one rule the control plane authorizes on.
 *
 * 🛑 **Only the device OWNER may command a device.** Commanding hardware is not a config write:
 * a non-owner admin driving someone else's car would do it using *that owner's* stored vendor
 * credentials (the Tesla capability deliberately loads tokens under the device owner, not the
 * caller). So the control plane asks "do you own this?", never "may you write?".
 *
 * This module is deliberately dependency-free so BOTH sides can use it: the server gate
 * (`requireDeviceAccess({requireOwner:true})`, `/api/data`'s emission) and the client gate
 * (`components/dashboard/v4/node-view.tsx`). One rule, one expression, no second authorization path.
 */

/**
 * Does this identity own this subject?
 *
 * 🛑 The two `!= null` terms are the whole point. Ownership is `userId === ownerId`, so on an
 * OWNERLESS device an anonymous caller compares `null === null` and would come back "owner" while
 * owning nothing — the exact quirk `/api/data` had to mask (`viewerCanWrite`) and that
 * `lib/__tests__/api-auth.test.ts` pins on the raw helper. An ownerless device is commandable by
 * NOBODY, so two nulls must never be a match.
 */
export function ownsSubject(
  userId: string | null | undefined,
  ownerId: string | null | undefined,
): boolean {
  return userId != null && ownerId != null && userId === ownerId;
}

/**
 * The client-side control gate: may the viewer this payload was built for command this subject?
 *
 * Reads `canControl`, which `/api/data` emits from the SAME auth result it authorized the read
 * with (`DashboardAuthContext.isOwner`). Absent — an SSR-seeded payload, which knows no viewer —
 * is false; the first client refetch fills it in.
 */
export function datumCanControl(
  datum: { canControl?: boolean } | null | undefined,
): boolean {
  return datum?.canControl === true;
}
