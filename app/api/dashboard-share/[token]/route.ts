import { NextRequest, NextResponse } from "next/server";
import {
  DASHBOARD_SHARING,
  validateDashboardShareToken,
} from "@/lib/dashboard/sharing";
import { getDashboardById } from "@/lib/dashboard/store";
import { resolveDashboardReadPoints } from "@/lib/dashboard/access";
import { SystemsManager } from "@/lib/systems-manager";
import { getLatestPointValues } from "@/lib/kv-cache-manager";

/**
 * Public consumption of a per-dashboard share token (P4) — the not-previously-built share-token GET
 * path. The token IS the authorization (no Clerk session needed): validate → resolve its dashboard →
 * return the descriptor + the EXACT point scope the dashboard exposes (lib/dashboard/access.ts), plus
 * minimal public system metadata. A holder gets nothing beyond that scope.
 *
 * Gated by DASHBOARD_SHARING (404 when off). Serving the live values/history/flow for those points to
 * token holders (so the shared view renders end-to-end) is the next slice; this returns the access
 * scope + descriptor.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!DASHBOARD_SHARING) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { token } = await params;

  const valid = await validateDashboardShareToken(token);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid or expired link" },
      { status: 404 },
    );
  }

  const dashboard = await getDashboardById(valid.dashboardId);
  if (!dashboard) {
    return NextResponse.json({ error: "Dashboard not found" }, { status: 404 });
  }

  const system = await SystemsManager.getInstance().getSystem(
    dashboard.systemId,
  );
  if (!system) {
    return NextResponse.json({ error: "System not found" }, { status: 404 });
  }

  const access = await resolveDashboardReadPoints(dashboard.systemId);
  // The system's latest map IS the dashboard's (1:1), so this is already scoped — a self-contained,
  // renderable payload (descriptor + live values + scope) with no general system access granted.
  const latest = await getLatestPointValues(dashboard.systemId);

  return NextResponse.json({
    systemId: dashboard.systemId,
    system: {
      id: system.id,
      displayName: system.displayName,
      vendorType: system.vendorType,
      timezoneOffsetMin: system.timezoneOffsetMin,
    },
    descriptor: dashboard.descriptor,
    systemIds: access.systemIds,
    points: access.points,
    latest,
  });
}
