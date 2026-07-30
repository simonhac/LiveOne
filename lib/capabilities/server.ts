/**
 * Server-side capability resolution — the ELIGIBILITY answer ("which cards CAN this area/device show")
 * derived from CONFIG (`point_info` + derivations + grid context), so it is defined before any reading has
 * arrived. This is the server half of the capability model; the client half is `capabilitiesFromLatest`
 * (runtime presence). Both consume the same registry rule table.
 *
 * ONE entry point for a real device OR an area: `getActivePointsForDevice(handle)` already unions an
 * area's member points (areas-backed → member/bound points; real device → its own), so the ATOMIC
 * capabilities fall straight out of `capabilitiesFromPoints`. COMPOUND capabilities are predicates:
 *  - `generator-running` — any member device has an enabled generator run-detector `derivations` row.
 *  - `grid-signals`      — the area's location derives a NEM region backed by a seeded OE device
 *                          (`resolveGridContextForDevice`).
 *
 * Server-only (imports the DB/point layer). Do NOT import from a client component — use
 * `capabilitiesFromLatest` there.
 */
import { PointManager } from "@/lib/point/point-manager";
import { getAreaForDevice } from "@/lib/areas/resolve";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { DeviceRegistry } from "@/lib/registry";
import { hasEnabledRunDetector } from "@/lib/derivations/resolve";
import { resolveGridContextForDevice } from "@/lib/grid/context";
import {
  capabilitiesFromPoints,
  isAggregateFromPoints,
} from "@/lib/capabilities/derive";
import { satisfies, CARD_CATALOG } from "@/lib/capabilities/catalog";
import {
  applyCapabilityConfig,
  type DeviceConfig,
} from "@/lib/capabilities/config";
import { buildAreaStrategy } from "@/lib/capabilities/strategy";
import { areaStrategyGroupToV3 } from "@/lib/capabilities/strategy-v3";
import type { CapabilityId } from "@/lib/capabilities/registry";
import type { CapabilitySet } from "@/lib/capabilities/derive";
import type { DeviceId } from "@/lib/ids";
import type { DashboardV3 } from "@/lib/dashboard/v3";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/**
 * The member systemIds behind a handle: an area's `area_members`, or the handle itself (a real device).
 *
 * Membership is uuid-keyed since slice H, but every consumer here still joins int-keyed columns
 * (`systems.id`, the run-detector lookup), so it converts back. The `!` is safe by the
 * `area_members.device_id` FK — see `DeviceRegistry.ridsForDevices`.
 */
export async function memberSystemIds(handle: number): Promise<number[]> {
  const area = await getAreaForDevice(handle);
  if (area) {
    const memberIds = await getAreaMemberDeviceIds(area.id);
    if (memberIds.length) {
      const rids = await DeviceRegistry.ridsForDevices(memberIds);
      return memberIds.map((id) => rids.get(id)!);
    }
  }
  return [handle];
}

/**
 * Shared computation behind `capabilitiesForDevice` and `derivedCapabilitiesForDevice`: the DERIVED
 * capability set (atomic points + the generator/grid-signals compound predicates) plus the merged
 * per-member config overrides — everything except the final `applyCapabilityConfig`.
 */
async function resolveDeviceCapabilities(handle: number): Promise<{
  derived: Set<CapabilityId>;
  overrides: DeviceConfig["capabilities"];
}> {
  const pm = PointManager.getInstance();
  const points = await pm.getActivePointsForDevice(handle, false, false);
  const caps = capabilitiesFromPoints(points);

  // Walk the member devices once: gather generator-run-tracking + merge their config overrides
  // (later member wins for the same capability). A device's own handle is its own single member.
  const members = await memberSystemIds(handle);
  const overrides: DeviceConfig["capabilities"] = {};
  let hasGenerator = false;
  for (const sid of members) {
    const sys = await DeviceConfigRegistry.deviceByHandle(sid);
    if (sys?.config?.capabilities)
      Object.assign(overrides, sys.config.capabilities);
    if (!hasGenerator && (await hasEnabledRunDetector(sid, "generator")))
      hasGenerator = true;
  }
  if (hasGenerator) caps.add("generator-running");

  // grid-signals: the area's location derives a NEM region + a seeded OE region system.
  if (await resolveGridContextForDevice(handle)) caps.add("grid-signals");

  return { derived: caps, overrides };
}

/**
 * The capability set a handle offers from config. `handle` is a real device id OR an area's
 * `legacy_system_id` — both resolve through `getActivePointsForDevice`.
 */
export async function capabilitiesForDevice(
  handle: number,
): Promise<Set<CapabilityId>> {
  const { derived, overrides } = await resolveDeviceCapabilities(handle);
  // Per-device config overrides (no-op when unconfigured — parity preserved).
  return applyCapabilityConfig(derived, { capabilities: overrides });
}

/**
 * Cheap CONFIG-only eligibility check for the chart/sankey cards (`{all:["solar/power"]}`) — just the
 * points scan + the same catalog rule `capabilitiesFromLatest` checks client-side against `latest`,
 * skipping the generator/grid-signals compound predicates `capabilitiesForDevice` also computes
 * (irrelevant to chart eligibility). Lets a dashboard-descriptor read thread a synchronous "will this
 * area ever show a chart" fact to the client, so `SiteChartsGroup` doesn't have to wait on
 * `/api/data`'s live `latest` map before firing its (expensive) history/sankey fetch.
 */
export async function hasChartCapability(handle: number): Promise<boolean> {
  const points = await PointManager.getInstance().getActivePointsForDevice(
    handle,
    false,
    false,
  );
  return satisfies(capabilitiesFromPoints(points), CARD_CATALOG.chart.requires);
}

/**
 * The capability set a handle offers **before** its own config overrides are applied — the "Default"
 * baseline the configurator annotates each toggle with. Same computation as `capabilitiesForDevice`
 * minus the final `applyCapabilityConfig`.
 */
export async function derivedCapabilitiesForDevice(
  handle: number,
): Promise<Set<CapabilityId>> {
  return (await resolveDeviceCapabilities(handle)).derived;
}

/**
 * The CONFIG-derived inputs behind a handle's area strategy — its capability set, whether it
 * aggregates multiple sources, and the OE region device (as a legacy handle) the `oe-grid` card binds.
 * Split out so the v4 seed path (`lib/dashboard/v4-seed.ts`, which resolves that handle to a `dv_`)
 * and the v3 projection below share one resolution.
 */
export interface AreaStrategyInputs {
  capabilities: CapabilitySet;
  aggregate: boolean;
  /** The OE region device's legacy `system_id`; absent when the area has no grid context. */
  gridDeviceSystemId?: number;
}

export async function resolveAreaStrategyInputs(
  handle: number,
): Promise<AreaStrategyInputs> {
  const pm = PointManager.getInstance();
  const points = await pm.getActivePointsForDevice(handle, false, false);
  const capabilities = await capabilitiesForDevice(handle);
  const gridDeviceSystemId = (await resolveGridContextForDevice(handle))
    ?.regionSystemId;
  return {
    capabilities,
    aggregate: isAggregateFromPoints(points),
    gridDeviceSystemId,
  };
}

/**
 * 🛑 TEMPORARY — the v3-shaped default dashboard (the "area strategy") for a handle, for the three
 * consumers that still read v3: `/device/{id}` (stage 9) plus `GET /api/areas/{id}/default-section`
 * and `POST /api/dashboards` (stage 13). It builds the v4 group and projects it back
 * (`strategy-v3.ts`); both this function and that projection go when the last consumer does.
 *
 * `areaId` is the section's Area uuid (what the descriptor stores) — or `/device/{id}`'s synthetic
 * `device-{id}` key, which is not an area ref at all, hence the group is built unbound and the raw
 * string re-attached on the way back. `handle` is the integer `legacy_system_id` the resolvers key on.
 *
 * The one device pin the strategy emits (the `oe-grid` card) is resolved to a `dv_` so the v4 builder
 * can carry it in the envelope, then mapped straight back. An unresolvable handle degrades to "no
 * oe-grid card" — matching `resolveGridContextForDevice`'s own posture that the grid card is additive
 * and must never break the page.
 */
export async function buildAreaStrategyForHandle(
  areaId: string,
  handle: number,
  opts?: { leadWithDeviceMetrics?: boolean },
): Promise<DashboardV3> {
  const inputs = await resolveAreaStrategyInputs(handle);
  const gridHandle = inputs.gridDeviceSystemId;
  const gridDevice: DeviceId | undefined =
    gridHandle != null
      ? (await DeviceRegistry.addrsForHandles([gridHandle])).get(gridHandle)
          ?.deviceId
      : undefined;
  const group = buildAreaStrategy({
    capabilities: inputs.capabilities,
    aggregate: inputs.aggregate,
    gridDevice,
    leadWithDeviceMetrics: opts?.leadWithDeviceMetrics,
  });
  return areaStrategyGroupToV3(group, {
    areaId,
    handleForDevice: new Map(
      gridDevice && gridHandle != null ? [[gridDevice, gridHandle]] : [],
    ),
  });
}
