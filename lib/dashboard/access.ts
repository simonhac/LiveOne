/**
 * Dashboard read-access resolution (per-dashboard sharing).
 *
 * The security boundary for a shared dashboard: it exposes **exactly the points its data shows**, and
 * nothing more (areas-and-dashboards.md §2). A share-token / grant holder gets read access
 * transitively: Dashboard → its Area(s) → `area_bindings` → `(system_id, point_id)`.
 *
 * The scope is the **union of the dashboard's section Areas**: each v3 section's `areaId` maps to its
 * addressable systemId (`legacy_system_id`), and `PointManager.getActivePointsForSystem` resolves each
 * to a composite's CHILD points or a single system's own points. The authorized set is BOTH the area
 * handles (whole-area cards address `/api/data?systemId=<handle>`) AND those child/member systems
 * (member-scoped cards — generator-runs, device-metrics — address them directly), so the exposed set
 * matches what the dashboard renders by construction. (P6 dropped the legacy `dashboards.system_id`/
 * `area_id` seed: scope is now purely descriptor-derived.) Point-level narrowing within an Area is a
 * future tightening — `points[]` already carries the exact refs.
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
 * Resolve a descriptor's Areas to (a) the area HANDLES — how whole-area cards address the data
 * (`/api/data?systemId=<handle>`) — and (b) the CHILD/MEMBER point refs those areas expose. Shared by
 * the scope + point resolvers. Unresolvable Area uuids are dropped (no escalation); a handle whose
 * points can't resolve (deleted/dangling) keeps the handle but contributes no points.
 */
async function resolveAreas(input: DashboardScopeInput): Promise<{
  handles: number[];
  refs: { systemId: number; pointId: number }[];
}> {
  const pm = PointManager.getInstance();
  const handles: number[] = [];
  const refs: { systemId: number; pointId: number }[] = [];
  for (const areaId of descriptorAreaIds(input.descriptor)) {
    const handle = await getLegacySystemIdForArea(areaId);
    if (handle == null) continue; // dangling/deleted Area uuid → dropped.
    handles.push(handle);
    try {
      const pts = await pm.getActivePointsForSystem(handle, false);
      refs.push(...pts.map((p) => p.getReference()));
    } catch {
      // unresolvable handle → keep the handle, no member points.
    }
  }
  return { handles, refs };
}

/**
 * The distinct systemIds a shared dashboard authorizes: for each Area its v3 descriptor references,
 * BOTH the area HANDLE (whole-area cards fetch `/api/data?systemId=<handle>`) AND the child/member
 * systems whose points the area actually shows. The member expansion is essential: member-scoped cards
 * (generator-runs → `/api/system/<member>/run-periods`, device-metrics → `/api/data?systemId=<member>`)
 * would otherwise 401 for an anonymous share viewer even though the dashboard renders their data.
 * Unresolvable Area uuids are dropped (no escalation). Empty/unresolvable descriptor → empty scope.
 */
export async function allowedSystemIds(
  input: DashboardScopeInput,
): Promise<number[]> {
  const { handles, refs } = await resolveAreas(input);
  return [...new Set([...handles, ...refs.map((r) => r.systemId)])];
}

/**
 * The read-access set for a dashboard — the exact points across its Areas (a composite spans its
 * children). An unresolvable handle is defensively skipped rather than 500-ing the caller.
 */
export async function resolveDashboardReadPoints(
  input: DashboardScopeInput,
): Promise<DashboardReadAccess> {
  const { refs } = await resolveAreas(input);
  return toReadAccess(refs);
}
