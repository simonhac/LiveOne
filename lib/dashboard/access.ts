/**
 * Dashboard read-access resolution (per-dashboard sharing).
 *
 * The security boundary for a shared dashboard: it exposes **exactly the points its data shows**, and
 * nothing more (areas-and-dashboards.md §2). A share-token / grant holder gets read access
 * transitively: Dashboard → its Area(s) → `area_bindings` → `(system_id, point_id)`.
 *
 * Phase 2 generalises the scope from a single system to the **union of the dashboard's card Areas**:
 * the dashboard's default Area (`dashboards.area_id`) ∪ each card's `areaId`. Each Area uuid maps to
 * its addressable systemId (`legacy_system_id`), and `PointManager.getActivePointsForSystem` resolves
 * each — returning a composite's CHILD points or a single system's own points — so the exposed set
 * matches what the dashboard renders by construction. Today every card is areaId-less and the default
 * Area maps back to the dashboard's own system, so the union is the singleton `{systemId}` and this is
 * inert (identical to the pre-Phase-2 single-system behaviour). Point-level narrowing within an Area
 * is a future tightening — `points[]` already carries the exact refs.
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

/** A dashboard's scope inputs: its default Area, its addressable systemId, and its card descriptor. */
export interface DashboardScopeInput {
  /** The dashboard's default Area (`dashboards.area_id`), or null when unset (back-compat). */
  defaultAreaId: string | null;
  /**
   * The dashboard's legacy integer system handle, or null for a composition-first dashboard (Phase
   * 2b-2) which has no home system — its scope is purely the union of its cards' Areas.
   */
  systemId: number | null;
  /** The dashboard descriptor (v3 composition, or a legacy v2 per-system descriptor). */
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
 * The distinct addressable system handles a dashboard may read: its default Area plus every distinct
 * per-card `areaId`, each mapped uuid → `legacy_system_id`. Unresolvable Area uuids are **dropped**
 * (no escalation, no throw). The dashboard's own `systemId` is always included (it's how the default
 * Area is addressed today). For today's single-area dashboards this returns the singleton `{systemId}`.
 */
export async function allowedSystemIds(
  input: DashboardScopeInput,
): Promise<number[]> {
  const areaIds = new Set<string>();
  if (input.defaultAreaId) areaIds.add(input.defaultAreaId);
  for (const aid of descriptorAreaIds(input.descriptor)) areaIds.add(aid);

  // No resolvable Areas → a legacy single-system dashboard (address by its systemId), or an empty
  // composition dashboard (no systemId, no cards) → empty scope.
  if (areaIds.size === 0) return input.systemId != null ? [input.systemId] : [];

  // Seed with the legacy home systemId when present (composition dashboards have none).
  const out = new Set<number>();
  if (input.systemId != null) out.add(input.systemId);
  for (const areaId of areaIds) {
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
