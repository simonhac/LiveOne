/**
 * config-v4 `/api/v4/dashboards/*` route helpers (Phase 6, DARK — writes go live at cutover).
 *
 * Shared owner-load + the §8.4 reference-readability check. config-v4: dashboards are addressed by their
 * opaque `db_…` id, which is passed straight to the DAO (`lib/dashboard/dashboards.ts` owns the id↔uuid
 * translation); a malformed/foreign id reads as not-found. Auth mirrors the v3 `/api/dashboards/[id]` route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { listReadableDevices } from "@/lib/devices/list";
import { Area } from "@/lib/ids";
import { getDashboard, type CompositionDashboard } from "./dashboards";
import { collectRefs } from "./v4-validate";
import type { DashboardV4 } from "./v4";

/** Authenticate + load a dashboard the caller owns (or is admin for). Mirrors the v3 route's loadOwned. */
export async function loadOwnedDashboard(
  request: NextRequest,
  idStr: string,
): Promise<
  { dashboard: CompositionDashboard; userId: string } | { error: NextResponse }
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };
  const dashboard = await getDashboard(idStr);
  if (!dashboard) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  // `auth.isAdmin` — NOT a second `isUserAdmin()` call. `getAuthContext` has already resolved it, and
  // the bare re-call re-entered `auth()` (an extra Clerk round trip on EVERY v4 dashboard request) and
  // disagreed with the context it was second-guessing: under the dev `x-claude` bypass `getAuthContext`
  // returns `{userId:"claude-dev", isAdmin:true}` with no Clerk session at all, so `isUserAdmin()`
  // resolved `userId` to null and answered `false`. Matches `loadAreaForOwner`, which was already
  // reading `auth.isAdmin`.
  const owns = dashboard.ownerClerkUserId === auth.userId;
  if (!owns && !auth.isAdmin) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { dashboard, userId: auth.userId };
}

/**
 * §8.4 no-escalation check: every AREA ref in the doc must be readable by the owner. Returns a 403
 * `NextResponse` on violation, else null. The §8.3 walk means a future/unknown card type cannot
 * smuggle either an area or a device past this check.
 */
export async function checkDocRefsReadable(
  doc: DashboardV4,
  ownerClerkUserId: string,
): Promise<NextResponse | null> {
  const refs = collectRefs(doc);
  const areaUuids = refs.areas
    .map((a) => {
      try {
        return Area.toUuid(a);
      } catch {
        return null;
      }
    })
    .filter((x): x is string => x != null);
  const [readableAreas, readableDevices] = await Promise.all([
    listReadableAreas(ownerClerkUserId),
    listReadableDevices(ownerClerkUserId),
  ]);
  const areaSet = new Set(readableAreas.map((a) => a.id));
  const deviceSet = new Set(readableDevices.map((d) => d.id));
  if (
    areaUuids.some((u) => !areaSet.has(u)) ||
    refs.devices.some((id) => !deviceSet.has(id))
  ) {
    return NextResponse.json(
      { error: "The doc references an area or device you cannot read" },
      { status: 403 },
    );
  }
  return null;
}

export type IfMatch =
  | { kind: "absent" }
  | { kind: "revision"; revision: number }
  | { kind: "invalid" };

/** Accept only an entire positive safe integer, either bare (`17`) or exactly quoted (`"17"`). */
export function parseIfMatch(header: string | null): IfMatch {
  if (header === null) return { kind: "absent" };
  const value = header.trim();
  const match = /^(?:([1-9]\d*)|"([1-9]\d*)")$/.exec(value);
  if (!match) return { kind: "invalid" };
  const revision = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(revision)
    ? { kind: "revision", revision }
    : { kind: "invalid" };
}
