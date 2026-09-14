/**
 * Logical-system resolver — the single authority for "which physical points play which energy-flow
 * roles" for an Area Sankey view. A *logical system* is an explicit Area with a complete source/load
 * role set; its points may come from one member device or many, with `area_bindings` as an override.
 * Every Sankey path — the engine's daily recompute, the sub-daily history compute, and the FE —
 * consumes this one definition instead of re-deriving role classification independently.
 *
 * This wraps `PointManager.getActivePointsForDevice`, which already resolves points uniformly for any
 * handle (a multi-device area's points come back keyed by their *child* `systemId`, preserving
 * physical origin). The actual role split (battery→source/load, solar leaf/residual, rest-of-house)
 * stays in `buildFlowSeries`; this module only answers "which points, with which stems."
 */

import { PointReference } from "@/lib/identifiers";
import { Point, type PointId } from "@/lib/ids";
import { PointManager } from "@/lib/point/point-manager";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { classifyEnergyStem, isCompleteRoleSet } from "@/lib/roles/registry";
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
   * `resolveLogicalSystem` returns `null` (and logs) rather than yielding an Area-less device, so
   * the flow rollup never writes an un-keyed `point_readings_flow_attr_1d` row. `area_id` is the
   * primary key of that table (P3-tail-1). See areas-and-dashboards.md (P3).
   */
  areaId: string;
  /**
   * The AREA's fixed day offset — the boundary `point_readings_flow_attr_1d.day` is bucketed on.
   *
   * 🛑 Always the area's, never the device's. This used to fork on whether the handle named a device
   * (`device.timezoneOffsetMin`) or an area, which happened to agree only because a device's
   * placement is projected from its own area-of-one. The value keys an AREA-keyed table, so taking it
   * from anywhere but `areaId` is a latent mis-key: the moment a handle's device and its flow area
   * are not the same area — which is precisely what re-homing a device onto `devices.area_id`
   * introduces — the fork would bucket a day against one area and file it under another.
   *
   * Distinct from `devices.day_offset_min`, which buckets `point_readings_agg_1d` (PK'd on the POINT,
   * so it has no area to resolve through). The two agree today.
   */
  dayOffsetMin: number;
  /** Participating power points (may span physical devices for a multi-device area). */
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
 * Resolve the role→point mapping for a logical system. Returns null if the device doesn't exist.
 * Only typed power points participate (no `logical_path_stem` ⇒ excluded, matching the engine).
 */
export async function resolveLogicalSystem(
  systemId: number,
): Promise<LogicalSystem | null> {
  // The handle must name SOMETHING — a real device or an Area. Both are asked unconditionally now:
  // the area is needed for the day offset regardless of which the handle names, and `areaByHandle` is
  // `cache`d, so the second lookup is free. (`getActivePointsForDevice` below still does its own
  // device-first dispatch; this function only needs the area in order to KEY the result.)
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  const areaRow = await DeviceConfigRegistry.areaByHandle(systemId);
  if (!device && !areaRow) return null;

  // typedOnly=true drops points without a logical_path_stem (same exclusion as the engine recompute).
  const pts = await PointManager.getInstance().getActivePointsForDevice(
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
  // (P3-tail-1). Flow is AREA-only: a device with no Area has no flow to record, so return null (never
  // mint one here). Areas are EXPLICIT now — a device gets a flow view only once a user groups it into
  // an Area (createArea); it is NOT auto-minted at create-time or lazily healed here.
  //
  // This is `areaRow` — the row already resolved above — rather than a second handle→area lookup, so
  // the offset below is guaranteed to come from the very area the result is keyed on. (`areaRow` is
  // `DeviceConfigRegistry.areaByHandle`; `getAreaForDevice`, the other reader of that edge, is gone —
  // it answered the area leg without ever seeing the device leg. See
  // `docs/plans/exact-resolution-or-refuse.md`.)
  if (!areaRow) return null;

  return {
    id: systemId,
    areaId: areaRow.id,
    dayOffsetMin: areaRow.dayOffsetMin,
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
