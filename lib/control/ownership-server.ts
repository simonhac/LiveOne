/**
 * The SERVER half of the control gate — the part that has to touch the device registry.
 *
 * `lib/control/ownership.ts` is deliberately dependency-free so both sides can import it; this is
 * its server-only sibling, for the one question that needs a registry lookup. It lives here rather
 * than inside `app/api/data/route.ts` because two producers now answer it about the same payload:
 * the route, and the dashboard page's SSR prefetch — and a second copy is exactly how the client
 * and the server gate drift apart.
 */
import { ownsSubject } from "./ownership";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { controllableDeviceScopeForUser } from "@/lib/dashboard/grants";

/**
 * May this identity COMMAND this device? The device's owner, or the holder of a `control` grant on
 * a dashboard that shows it and whose owner owns it (`controllableDeviceScopeForUser`).
 *
 * This is THE control rule — `requireDeviceAccess({requireControl:true})` and both `/api/data`
 * emissions below all ask it. The grant leg is only consulted for a signed-in non-owner, so an
 * owner's request never touches the grants table.
 */
export async function canControlDevice(
  userId: string | null | undefined,
  device: { id: number; ownerClerkUserId?: string | null },
): Promise<boolean> {
  if (ownsSubject(userId, device.ownerClerkUserId)) return true;
  if (userId == null || device.ownerClerkUserId == null) return false;
  return (await controllableDeviceScopeForUser(userId)).has(device.id);
}

/**
 * The DEVICES inside this payload that the viewer may command — owned, or delegated by a `control`
 * grant (`canControlDevice`).
 *
 * 🛑 Why this exists next to `canControl`. `canControl` is about the SUBJECT the payload was
 * fetched under, and for an AREA that is the area, not the car: an area owner who does not own a
 * member device would see the EV cog and get a 403 on press. A control that visibly exists and then
 * refuses is a defect, so the client must gate on the device that would ACTUALLY be commanded.
 *
 * There is deliberately no second authorization path here. Every latest-map entry already carries
 * `sourceSystemId` (the producing `devices.rid` — see `lib/latest-values-store.ts`), so the set of
 * devices in play is read off the payload we just built; the rule is then the SAME predicate the
 * server gate itself uses, `canControlDevice`, against the same registry row `requireDeviceAccess`
 * resolves. It is still courtesy, never authority — `POST /api/v4/points/{pt_}/action`
 * re-authorizes with `requireControl` regardless of what this said.
 *
 * A share-token viewer arrives `userId: null` and so owns nothing, exactly as `canControl` does.
 */
export async function viewerControllableDevices(
  auth: { userId: string | null },
  payload: { latest?: Record<string, { sourceSystemId?: number }> },
): Promise<number[]> {
  if (auth.userId == null) return [];
  const handles = new Set<number>();
  for (const entry of Object.values(payload.latest ?? {})) {
    if (typeof entry?.sourceSystemId === "number")
      handles.add(entry.sourceSystemId);
  }
  const userId = auth.userId;
  // The grant scope is resolved at most once per payload, and only if some device isn't owned.
  let granted: Promise<Set<number>> | undefined;
  const controllable = await Promise.all(
    [...handles].map(async (handle) => {
      const device = await DeviceConfigRegistry.deviceByHandle(handle);
      if (!device) return null;
      if (ownsSubject(userId, device.ownerClerkUserId)) return handle;
      if (device.ownerClerkUserId == null) return null;
      granted ??= controllableDeviceScopeForUser(userId);
      return (await granted).has(handle) ? handle : null;
    }),
  );
  return controllable.filter((h): h is number => h !== null);
}

/**
 * The two viewer-relative control fields, for a payload built WITHOUT a viewer.
 *
 * `getDeviceDataForCache` → `buildDevicePayload` knows no caller ("access is the CALLER's
 * responsibility"), so the dashboard's SSR seed lands in React Query with neither field. The client
 * reads absent as false, so every control cog — the generator's, the EV's — was missing on first
 * paint and appeared only when the first client refetch replaced the seed, up to `staleTime` (25 s)
 * later. This annotates the seed with the answer the route would have given.
 *
 * 🛑 `canControl` is the same rule `/api/data` emits (`subjectCanControl`): strict ownership of the
 * subject, or — for a DEVICE subject — a `control` grant that delegates it. It cannot widen access
 * either way: the caller only annotates payloads it had already fetched and authorized, both halves
 * fail closed on `userId == null` (the shared/anonymous view), and the action route re-authorizes
 * with `requireControl`.
 */
export async function viewerControlFields(
  payload: {
    latest?: Record<string, { sourceSystemId?: number }>;
    device?: { id?: number; ownerClerkUserId?: string | null };
    area?: { ownerClerkUserId?: string | null };
  },
  userId: string | null,
): Promise<{ canControl: boolean; canControlDevices: number[] }> {
  const canControlDevices = await viewerControllableDevices(
    { userId },
    payload,
  );
  return {
    canControl: subjectCanControl(payload, userId, canControlDevices),
    canControlDevices,
  };
}

/**
 * The subject-level `canControl`: the viewer owns the subject, or the subject is a DEVICE that
 * `canControlDevices` (already computed with the grant rule) lists. An AREA is never commanded
 * itself, so a `control` grant does not make an area subject controllable — tiles that command a
 * device inside an area gate on `canControlDevices` instead (`datumCanControlPoint`).
 */
export function subjectCanControl(
  payload: {
    device?: { id?: number; ownerClerkUserId?: string | null };
    area?: { ownerClerkUserId?: string | null };
  },
  userId: string | null,
  canControlDevices: readonly number[],
): boolean {
  if (ownsSubject(userId, (payload.device ?? payload.area)?.ownerClerkUserId))
    return true;
  const id = payload.device?.id;
  return typeof id === "number" && canControlDevices.includes(id);
}
