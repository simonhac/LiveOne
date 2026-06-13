/**
 * Logical-system resolver — the single authority for "which physical points play which energy-flow
 * roles" for a Sankey view. A *logical system* is a complete source/load role set; it is either a
 * composite (`vendor_type='composite'`, role→point mappings in `systems.metadata`) or a single
 * physical system whose own points already cover the roles. Both resolve to the same shape here, so
 * every Sankey path — the engine's daily recompute, the sub-daily history compute, and the FE —
 * consumes one definition instead of re-deriving role classification independently.
 *
 * This wraps `PointManager.getActivePointsForSystem`, which already handles the composite-vs-single
 * split (composite points come back keyed by their *child* `systemId`, preserving physical origin).
 * The actual role split (battery→source/load, solar leaf/residual, rest-of-house) stays in
 * `buildFlowSeries`; this module only answers "which points, with which stems."
 */

import { PointReference } from "@/lib/identifiers";
import { PointManager } from "@/lib/point/point-manager";
import { SystemsManager } from "@/lib/systems-manager";
import { isCompleteRoleSet } from "@/lib/roles/registry";
import { getAreaForSystem } from "@/lib/areas/resolve";

// Re-exported for back-compat: the role taxonomy now lives in lib/roles/registry.ts.
export { isCompleteRoleSet };

/** A power point participating in a logical system, carrying its physical origin. */
export interface LogicalSystemPoint {
  /** Physical origin: {systemId, pointId} — for a composite this is the child system. */
  ref: PointReference;
  /** Canonical logical-path stem, e.g. "source.solar.local" | "bidi.battery" | "load.hws". */
  stem: string;
  metricType: string;
  metricUnit: string | null;
  /** point_info.transform ("i" invert | "d" | null). Power points currently carry none. */
  transform: string | null;
  /** Display name (displayName || defaultName) for label resolution. */
  displayName: string;
}

export interface LogicalSystem {
  /** The logical-system id == systems.id (composite or single). */
  id: number;
  /**
   * The Area this view belongs to (the area whose `legacy_system_id == id`), or null when
   * `AREAS_TABLE` is off or the Area hasn't been backfilled yet. Drives the forward-only
   * `point_readings_flow_1d.area_id` re-key — `id` (system_id) stays the primary key through the
   * soak, so this is additive and a no-op when the flag is off. See areas-and-dashboards.md (P3).
   */
  areaId: string | null;
  timezoneOffsetMin: number;
  /** Participating power points (may span physical systems for a composite). */
  points: LogicalSystemPoint[];
  /** Has at least one source role and one load role → a Sankey can be built. */
  isComplete: boolean;
}

/**
 * Resolve the role→point mapping for a logical system. Returns null if the system doesn't exist.
 * Only typed power points participate (no `logical_path_stem` ⇒ excluded, matching the engine).
 */
export async function resolveLogicalSystem(
  systemId: number,
): Promise<LogicalSystem | null> {
  const system = await SystemsManager.getInstance().getSystem(systemId);
  if (!system) return null;

  // typedOnly=true drops points without a logical_path_stem (same exclusion as the engine recompute).
  const pts = await PointManager.getInstance().getActivePointsForSystem(
    systemId,
    true,
  );

  const points: LogicalSystemPoint[] = pts
    .filter((p) => p.metricType === "power" && p.logicalPathStem)
    .map((p) => ({
      ref: p.getReference(),
      stem: p.logicalPathStem!,
      metricType: p.metricType,
      metricUnit: p.metricUnit,
      transform: p.transform,
      displayName: p.name,
    }));

  // Resolve the Area this view belongs to (null when AREAS_TABLE is off / not yet backfilled).
  const area = await getAreaForSystem(systemId);

  return {
    id: systemId,
    areaId: area?.id ?? null,
    timezoneOffsetMin: system.timezoneOffsetMin,
    points,
    isComplete: isCompleteRoleSet(points.map((p) => p.stem)),
  };
}

/**
 * All active systems that form a complete logical system (a usable source/load role set). This is
 * the set the daily flow recompute should analyse — it includes composites, which the legacy
 * `SELECT DISTINCT system_id FROM agg_5m` driver structurally excluded.
 */
export async function listCompleteLogicalSystems(): Promise<LogicalSystem[]> {
  const systems = await SystemsManager.getInstance().getActiveSystems();
  const resolved = await Promise.all(
    systems.map((s) => resolveLogicalSystem(s.id)),
  );
  return resolved.filter((ls): ls is LogicalSystem => !!ls && ls.isComplete);
}
