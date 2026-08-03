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

/** The shape `datumCanControlPoint` reads — a `/api/data` payload, however it was fetched. */
export interface ControlAwareDatum {
  canControl?: boolean;
  /** `devices.rid`s in this payload the viewer OWNS (`/api/data`'s `viewerControllableDevices`). */
  canControlDevices?: number[];
  latest?: Record<string, { sourceSystemId?: number } | null | undefined>;
  /**
   * The payload's discriminated subject block: exactly one of these is present
   * (`lib/dashboard/serve-data.ts`). `device` present means subject and target are the same thing
   * by construction, which is the only case the stale-entry fallback below may trust.
   */
  device?: unknown;
  area?: unknown;
}

/**
 * The client-side control gate for a control that commands a SPECIFIC point — the one the EV tile's
 * cog needs.
 *
 * 🛑 `datumCanControl` answers about the payload's SUBJECT, and for a tile filed inside a
 * multi-device AREA that is the area, not the car. An area owner who does not own the car would get
 * a cog that 403s on press: it fails safe, but a control that visibly exists and then refuses is a
 * defect. So gate on ownership of the device that would ACTUALLY be commanded, which the payload
 * already tells us: each latest entry carries its producing device (`sourceSystemId`), and
 * `canControlDevices` lists the ones this viewer owns. Same server-side ownership rule, no second
 * authorization path, no extra request.
 *
 * `paths` is tried in order — the caller's command targets, most specific first. The first one
 * PRESENT in `latest` names the device; if none are present there is nothing to command anyway.
 *
 * Fallbacks, all fail-safe:
 * - an SSR-seeded payload (no viewer, so neither field) → false, as before;
 * - an entry from a stale KV write with no `sourceSystemId` → the subject-level flag, but ONLY on a
 *   DEVICE subject, where subject and target are the same thing by construction. On an area subject
 *   that is exactly the case this function exists to refuse, so it stays false.
 */
export function datumCanControlPoint(
  datum: ControlAwareDatum | null | undefined,
  paths: readonly string[],
): boolean {
  if (!datum) return false;
  for (const path of paths) {
    const entry = datum.latest?.[path];
    if (!entry) continue;
    const handle = entry.sourceSystemId;
    if (typeof handle !== "number")
      return datum.device != null && datumCanControl(datum);
    return datum.canControlDevices?.includes(handle) === true;
  }
  return false;
}
