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

/**
 * The DEVICES inside this payload that the viewer strictly owns — i.e. the ones they may command.
 *
 * 🛑 Why this exists next to `canControl`. `canControl` is about the SUBJECT the payload was
 * fetched under, and for an AREA that is the area, not the car: an area owner who does not own a
 * member device would see the EV cog and get a 403 on press. A control that visibly exists and then
 * refuses is a defect, so the client must gate on the device that would ACTUALLY be commanded.
 *
 * There is deliberately no second authorization path here. Every latest-map entry already carries
 * `sourceSystemId` (the producing `devices.rid` — see `lib/latest-values-store.ts`), so the set of
 * devices in play is read off the payload we just built; ownership is then the SAME predicate the
 * server gate itself uses, `ownsSubject`, against the same registry row `requireDeviceAccess`
 * resolves. It is still courtesy, never authority — `POST /api/v4/points/{pt_}/action`
 * re-authorizes with `requireOwner` regardless of what this said.
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
  const owned = await Promise.all(
    [...handles].map(async (handle) => {
      const device = await DeviceConfigRegistry.deviceByHandle(handle);
      return ownsSubject(auth.userId, device?.ownerClerkUserId) ? handle : null;
    }),
  );
  return owned.filter((h): h is number => h !== null);
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
 * 🛑 `canControl` IS `ownsSubject` against the payload's own subject block. The route emits
 * `authResult.isOwner`, and `DashboardAuthContext.isOwner` is itself strict `ownsSubject` — so this
 * is the same predicate, not a second rule, and it is the same `ownerClerkUserId` the prefetch's
 * pin-safety guard already reads. It cannot widen access either way: the caller only annotates
 * payloads it had already fetched and authorized, both halves fail closed on `userId == null` (the
 * shared/anonymous view), and the action route re-authorizes with `requireOwner`.
 */
export async function viewerControlFields(
  payload: {
    latest?: Record<string, { sourceSystemId?: number }>;
    device?: { ownerClerkUserId?: string | null };
    area?: { ownerClerkUserId?: string | null };
  },
  userId: string | null,
): Promise<{ canControl: boolean; canControlDevices: number[] }> {
  const owner = (payload.device ?? payload.area)?.ownerClerkUserId;
  return {
    canControl: ownsSubject(userId, owner),
    canControlDevices: await viewerControllableDevices({ userId }, payload),
  };
}
