/**
 * Dashboard read-access resolution (per-dashboard sharing).
 *
 * The security boundary for a shared dashboard: it exposes **exactly the points its data shows**, and
 * nothing more (areas-and-dashboards.md §2). A share-token / grant holder gets read access
 * transitively: Dashboard → its Area(s) → `area_bindings` → `(system_id, point_id)`.
 *
 * The scope is the **union of the dashboard's section Areas**: each v3 section's `areaId` maps to its
 * addressable systemId (`legacy_system_id`), and `PointManager.getActivePointsForSystem` resolves each
 * — returning a composite's CHILD points or a single system's own points — so the exposed set matches
 * what the dashboard renders by construction. (P6 dropped the legacy `dashboards.system_id`/`area_id`
 * seed: scope is now purely descriptor-derived.) Point-level narrowing within an Area is a future
 * tightening — `points[]` already carries the exact refs.
 */
import { PointManager } from "@/lib/point/point-manager";
import { getLegacySystemIdForArea } from "@/lib/areas/resolve";
import { descriptorAreaIds } from "./composition";

export interface DashboardReadAccess {
  /** Distinct physical systems the dashboard's points live on (a composite spans children). */
  systemIds: number[];
  /** The exact `(systemId, pointId)` points the dashboard exposes — the read-scope for a share grant. */
  points: { systemId: number; pointId: number }[];
}

/** A dashboard's scope inputs: just its descriptor. Scope = the union of its sections' Areas. */
export interface DashboardScopeInput {
  /** The dashboard descriptor (v3 composition; sections carry real Area uuids). */
  descriptor: unknown;
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
 * The distinct addressable system handles a dashboard may read: every distinct Area uuid its v3
 * descriptor references (its sections), each mapped uuid → `legacy_system_id`. Unresolvable Area uuids
 * are **dropped** (no escalation, no throw). Purely descriptor-derived — a shared dashboard exposes
 * exactly the systems its sections render. An empty/unresolvable descriptor → empty scope.
 */
export async function allowedSystemIds(
  input: DashboardScopeInput,
): Promise<number[]> {
  const out = new Set<number>();
  for (const areaId of descriptorAreaIds(input.descriptor)) {
    const sid = await getLegacySystemIdForArea(areaId);
    if (sid != null) out.add(sid); // sid == null → dangling/deleted Area uuid → dropped.
  }
  return [...out];
}

/**
 * The read-access set for a dashboard — the union of points across its allowed Area set. Each allowed
 * systemId is resolved area-aware via the point layer; an unresolvable handle (deleted/dangling) is
 * defensively skipped (`getActivePointsForSystem` throws "System not found") rather than 500-ing the
 * caller.
 */
export async function resolveDashboardReadPoints(
  input: DashboardScopeInput,
): Promise<DashboardReadAccess> {
  const systemIds = await allowedSystemIds(input);
  const pm = PointManager.getInstance();
  const refs: { systemId: number; pointId: number }[] = [];
  for (const sid of systemIds) {
    try {
      const pts = await pm.getActivePointsForSystem(sid, false);
      refs.push(...pts.map((p) => p.getReference()));
    } catch {
      continue;
    }
  }
  return toReadAccess(refs);
}
