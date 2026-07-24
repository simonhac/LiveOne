/**
 * config-v4 `/api/v4/dashboards/*` route helpers (Phase 6, DARK — writes go live at cutover).
 *
 * Shared owner-load + the §8.4 reference-readability check. Dashboards are addressed by their CURRENT
 * serial id (int) here; `db_…` TypeID addressing lands at cutover (dashboards get uuid ids + `legacy_id`
 * — there is no int↔TypeID mapping pre-cutover). Auth mirrors the v3 `/api/dashboards/[id]` route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { isUserAdmin } from "@/lib/auth-utils";
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
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return {
      error: NextResponse.json({ error: "Invalid id" }, { status: 400 }),
    };
  }
  const dashboard = await getDashboard(id);
  if (!dashboard) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  const owns = dashboard.ownerClerkUserId === auth.userId;
  if (!owns && !(await isUserAdmin())) {
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
