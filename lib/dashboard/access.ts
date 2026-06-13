/**
 * Dashboard read-access resolution (P4 — per-dashboard sharing).
 *
 * The security boundary for a shared dashboard: it exposes **exactly the points its data shows**, and
 * nothing more (areas-and-dashboards.md — "Sharing & access"). A share-token / grant holder gets read
 * access transitively: Dashboard → its Area → `area_bindings` → `(system_id, point_id)`.
 *
 * For the MVP this resolves from the dashboard's system (1:1 with its Area today). It reuses the
 * area-aware point resolution in `PointManager.getActivePointsForSystem` — which already returns a
 * composite's CHILD points and a single system's own points — so the exposed set matches what the
 * dashboard renders by construction. Per-card narrowing comes with the later `dashboard_cards` split.
 */
import { PointManager } from "@/lib/point/point-manager";

export interface DashboardReadAccess {
  /** Distinct physical systems the dashboard's points live on (a composite spans children). */
  systemIds: number[];
  /** The exact `(systemId, pointId)` points the dashboard exposes — the read-scope for a share grant. */
  points: { systemId: number; pointId: number }[];
}

/** Pure shaping of point refs → the dedup'd read-access set. Extracted for unit testing. */
export function toReadAccess(
  refs: { systemId: number; pointId: number }[],
): DashboardReadAccess {
  const points = refs.map((r) => ({
    systemId: r.systemId,
    pointId: r.pointId,
  }));
  const systemIds = [...new Set(points.map((p) => p.systemId))];
  return { systemIds, points };
}

/**
 * The read-access set for the dashboard of `systemId` — its Area's points (composite child points, or
 * the single system's own points), resolved area-aware via the existing point layer.
 */
export async function resolveDashboardReadPoints(
  systemId: number,
): Promise<DashboardReadAccess> {
  const pts = await PointManager.getInstance().getActivePointsForSystem(
    systemId,
    false,
  );
  return toReadAccess(pts.map((p) => p.getReference()));
}
