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
 * `NextResponse` on violation, else null. Device refs are not checked pre-cutover (no devices yet);
 * the §8.3 walk means a future/unknown card type still can't smuggle an area past this.
 */
export async function checkDocAreasReadable(
  doc: DashboardV4,
  ownerClerkUserId: string,
): Promise<NextResponse | null> {
  const areaUuids = collectRefs(doc)
    .areas.map((a) => {
      try {
        return Area.toUuid(a);
      } catch {
        return null;
      }
    })
    .filter((x): x is string => x != null);
  if (areaUuids.length === 0) return null;
  const readable = new Set(
    (await listReadableAreas(ownerClerkUserId)).map((a) => a.id),
  );
  if (areaUuids.some((u) => !readable.has(u))) {
    return NextResponse.json(
      { error: "The doc references an area you cannot read" },
      { status: 403 },
    );
  }
  return null;
}

/** Parse an `If-Match` header value (`"17"` or `17`) → the numeric revision, or undefined. */
export function parseIfMatch(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = parseInt(header.replace(/"/g, "").trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}
