/**
 * Logical-system resolver — the single authority for "which physical points play which energy-flow
 * roles" for an Area Sankey view. A *logical system* is an explicit Area with a complete source/load
 * role set; its points may come from one member device or many, with `area_bindings` as an override.
 * Every Sankey path — the engine's daily recompute, the sub-daily history compute, and the FE —
 * consumes this one definition instead of re-deriving role classification independently.
 *
 * This wraps `PointManager.getActivePointsForSystem`, which already resolves points uniformly for any
 * handle (a multi-device area's points come back keyed by their *child* `systemId`, preserving
 * physical origin). The actual role split (battery→source/load, solar leaf/residual, rest-of-house)
 * stays in `buildFlowSeries`; this module only answers "which points, with which stems."
 */

import { PointReference } from "@/lib/identifiers";
import { Point, type PointId } from "@/lib/ids";
import { PointManager } from "@/lib/point/point-manager";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { classifyEnergyStem, isCompleteRoleSet } from "@/lib/roles/registry";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { listFlowEligibleAreaHandles } from "@/lib/areas/members";

// Re-exported for back-compat: the role taxonomy now lives in lib/roles/registry.ts.
export { isCompleteRoleSet };

/** A power point participating in a logical system, carrying its physical origin. */
export interface LogicalSystemPoint {
  /**
   * The point's identity (`point_info.point_uid`, NOT NULL). Carried alongside `ref` so the
   * readings seam can be addressed directly — `flow-series-pg.ts` used to spend a
   * `RegistryCache.pointForAddr` round trip per point rediscovering exactly this
   * (config-v4 Phase 12 slice D).
   */
  point: PointId;
  /**
   * Physical origin: {systemId, pointId} — for a multi-device area this is the child system.
   * Still needed: the flow builder's `NormRow`s and the `/api/history` served rows are both
   * addressed by the integer pair. It dies with the handle in Phase 13.
   */
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
  /** The logical-system handle == the Area's integer `legacy_handles.handle`. */
  id: number;
  /**
   * The Area this view belongs to (the area whose `legacy_system_id == id`). Always present:
   * `resolveLogicalSystem` returns `null` (and logs) rather than yielding an Area-less system, so
   * the flow rollup never writes an un-keyed `point_readings_flow_attr_1d` row. `area_id` is the
   * primary key of that table (P3-tail-1). See areas-and-dashboards.md (P3).
   */
  areaId: string;
  timezoneOffsetMin: number;
  /** Participating power points (may span physical systems for a multi-device area). */
  points: LogicalSystemPoint[];
  /**
   * Flow-participating ENERGY-accumulator points (metric_type "energy" with a stem
   * `classifyEnergyStem` recognises) — the exact per-interval registers the flow pipeline prefers
   * over integrating `points`' average power. An OVERLAY only: role completeness (`isComplete`)
   * and flow eligibility are judged on the power `points` alone, so surfacing these changes no
   * area's eligibility.
   */
  energyPoints: LogicalSystemPoint[];
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
  // The handle must name SOMETHING — a real device or an Area. Phase 13 PR 2: this resolved a
  // device-shaped view and read only its existence and its `timezoneOffsetMin`, so it asks the two real
  // readers directly. Device-first, matching the deleted view's locked precedence (trap D-l).
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  const areaRow = device
    ? null
    : await DeviceConfigRegistry.areaByHandle(systemId);
  if (!device && !areaRow) return null;
  // Same value the view carried either way: `deviceByHandle` projects a device's offset FROM its
  // area-of-one, and the synthesized area view read it straight off the area.
  const timezoneOffsetMin = device
    ? device.timezoneOffsetMin
    : areaRow!.timezoneOffsetMin;

  // typedOnly=true drops points without a logical_path_stem (same exclusion as the engine recompute).
  const pts = await PointManager.getInstance().getActivePointsForSystem(
    systemId,
    true,
  );

  const points: LogicalSystemPoint[] = pts
    .filter((p) => p.metricType === "power" && p.logicalPathStem)
    .map((p) => ({
      point: Point.encode(p.pointUid),
      ref: p.getReference(),
      stem: p.logicalPathStem!,
      metricType: p.metricType,
      metricUnit: p.metricUnit,
      transform: p.transform,
      displayName: p.name,
    }));

  // Exact-energy overlay points (see `LogicalSystem.energyPoints`) — deliberately a SECOND list so
  // every existing consumer of `points` (role completeness, coverage checks, series classification)
  // keeps its power-only semantics untouched.
  const energyPoints: LogicalSystemPoint[] = pts
    .filter(
      (p) =>
        p.metricType === "energy" &&
        p.logicalPathStem &&
        classifyEnergyStem(p.logicalPathStem) !== null,
    )
    .map((p) => ({
      point: Point.encode(p.pointUid),
      ref: p.getReference(),
      stem: p.logicalPathStem!,
      metricType: p.metricType,
      metricUnit: p.metricUnit,
      transform: p.transform,
      displayName: p.name,
    }));

  const isComplete = isCompleteRoleSet(points.map((p) => p.stem));

  // A logical system MUST map to an Area — `area_id` is the primary key of point_readings_flow_attr_1d
  // (P3-tail-1). Flow is AREA-only: a system with no Area has no flow to record, so return null (never
  // mint one here). Areas are EXPLICIT now — a device gets a flow view only once a user groups it into
  // an Area (createArea); it is NOT auto-minted at create-time or lazily healed here.
  const area = await getAreaForSystem(systemId);
  if (!area) return null;

  return {
    id: systemId,
    areaId: area.id,
    timezoneOffsetMin,
    points,
    energyPoints,
    isComplete,
  };
}

/**
 * The Areas that form a complete logical system (a usable source/load role set) — the set the daily
 * flow recompute analyses. AREA-only: driven off `listFlowEligibleAreaHandles()` (active explicit
 * Areas), so a raw device never gets a duplicate Sankey. A grid-signal Area with no complete role set
 * drops out via the `isComplete` filter.
 */
export async function listCompleteLogicalSystems(): Promise<LogicalSystem[]> {
  const handles = await listFlowEligibleAreaHandles();
  const resolved = await Promise.all(
    handles.map((id) => resolveLogicalSystem(id)),
  );
  return resolved.filter((ls): ls is LogicalSystem => !!ls && ls.isComplete);
}
