import { NextRequest, NextResponse } from "next/server";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboardById } from "@/lib/dashboard/store";
import { resolveDashboardReadPoints } from "@/lib/dashboard/access";
import { SystemsManager } from "@/lib/systems-manager";
import { getLatestPointValues } from "@/lib/kv-cache-manager";

/**
 * Public consumption of a per-dashboard share token (P4). The token IS the authorization (no Clerk
 * session needed): validate → resolve its dashboard → return the descriptor + the EXACT point scope
 * the dashboard exposes (lib/dashboard/access.ts), plus minimal public system metadata. A holder gets
 * nothing beyond that scope.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
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
  // This legacy single-system payload only serves home-system dashboards. A composition-first
  // dashboard (Phase 2b-2, null system_id) is rendered by the new shared path instead.
  if (dashboard.systemId == null) {
    return NextResponse.json(
      { error: "Unsupported dashboard type for this endpoint" },
      { status: 404 },
    );
  }

  const system = await SystemsManager.getInstance().getSystem(
    dashboard.systemId,
  );
  if (!system) {
    return NextResponse.json({ error: "System not found" }, { status: 404 });
  }

  const access = await resolveDashboardReadPoints({
    defaultAreaId: dashboard.areaId,
    systemId: dashboard.systemId,
    descriptor: dashboard.descriptor,
  });
  // The system's latest map IS the dashboard's (1:1 today), so this is already scoped — a
  // self-contained, renderable payload (descriptor + live values + scope) with no general system
  // access granted. (When the multi-area UI lands, this `latest` fetch must union across
  // `access.systemIds`; today the descriptor is single-area so it's the dashboard's own system.)
  const latest = await getLatestPointValues(dashboard.systemId);

  return NextResponse.json({
    systemId: dashboard.systemId,
    system: {
      id: system.id,
      displayName: system.displayName,
      vendorType: system.vendorType,
      timezoneOffsetMin: system.timezoneOffsetMin,
    },
    // RAW saved descriptor. It is canonical (every stored row was migrated to the current `chart`
    // shape, and the read-shim is retired), so it carries no legacy card types. The share VIEWER
    // (not built yet) MUST still run normalizeDescriptor(descriptor, buildDefaultDescriptor(system,
    // latest, { gridSignalsAvailable })) before rendering, to reconcile card eligibility/order for
    // this system exactly as DashboardClient does — we don't normalize here because that needs the
    // page's full default context (grid-region + generator-tracker resolution) not assembled in this
    // endpoint.
    descriptor: dashboard.descriptor,
    systemIds: access.systemIds,
    points: access.points,
    latest,
  });
}
