/**
 * Server-side capability resolution — the ELIGIBILITY answer ("which cards CAN this area/device show")
 * derived from CONFIG (`point_info` + derivations + grid context), so it is defined before any reading has
 * arrived. This is the server half of the capability model; the client half is `capabilitiesFromLatest`
 * (runtime presence). Both consume the same registry rule table.
 *
 * ONE entry point for a real device OR an area: `getActivePointsForDevice(handle)` already unions an
 * area's member points (areas-backed → member/bound points; real device → its own), so the ATOMIC
 * capabilities fall straight out of `capabilitiesFromPoints`. COMPOUND capabilities are predicates:
 *  - run-tracking       — any member device is a SOURCE of an enabled run detector for a trackable
 *                         role (`derivation_sources.device_id`, migration 0063), mapped through
 *                         `RUN_TRACKING_CAPABILITY` (`generator` → `generator-running`,
 *                         `ev` → `ev-charging`). Source-of, not filed-under: a device that carries
 *                         only the detector's signal now lights the card up too.
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
import { runDetectorRolesForDevices } from "@/lib/derivations/resolve";
import { resolveGridContextForDevice } from "@/lib/grid/context";
import {
  capabilitiesFromPoints,
  isAggregateFromPoints,
} from "@/lib/capabilities/derive";
import { satisfies, NODE_CATALOG } from "@/lib/capabilities/catalog";
import {
  applyCapabilityConfig,
  type DeviceConfig,
} from "@/lib/capabilities/config";
import { buildAreaStrategy } from "@/lib/capabilities/strategy";
import {
  RUN_TRACKING_CAPABILITY,
  type CapabilityId,
  type TrackableRoleId,
} from "@/lib/capabilities/registry";
import type { CapabilitySet } from "@/lib/capabilities/derive";
import { Device, type DeviceId } from "@/lib/ids";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import { normalizeDocV4 } from "@/lib/dashboard/v4-validate";
import {
  DeviceConfigRegistry,
  type DeviceRecord,
} from "@/lib/registry/device-config";

/**
 * The member devices behind a handle: an area's `area_members`, or the handle's own device.
 *
 * The uuid is the PRIMITIVE since 0063 — the run-detector lookup joins `derivation_sources.device_id`
 * — and the `rid` rides along because `point_info` and the KV keyspace are still int-addressed.
 * {@link memberSystemIds} is the thin int-only wrapper the rest of the callers still use. The `!` is
 * safe by the `area_members.device_id` FK — see `DeviceRegistry.ridsForDevices`.
 */
export async function memberDevices(
  handle: number,
): Promise<{ deviceId: DeviceId; rid: number }[]> {
  const area = await getAreaForDevice(handle);
  if (area) {
    const memberIds = await getAreaMemberDeviceIds(area.id);
    if (memberIds.length) {
      const rids = await DeviceRegistry.ridsForDevices(memberIds);
      return memberIds.map((id) => ({ deviceId: id, rid: rids.get(id)! }));
    }
  }
  const own = await DeviceConfigRegistry.deviceByHandle(handle);
  return own ? [{ deviceId: own.deviceId, rid: handle }] : [];
}

export async function memberSystemIds(handle: number): Promise<number[]> {
  const members = await memberDevices(handle);
  // A handle that resolves to neither an area nor a device still has to answer with ITSELF: the
  // caller is about to ask `point_info`-shaped questions of it, and returning [] would silently turn
  // "unknown device" into "device with nothing on it".
  return members.length ? members.map((m) => m.rid) : [handle];
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

  // Walk the member devices once to merge their config overrides (later member wins for the same
  // capability). A device's own handle is its own single member.
  const members = await memberDevices(handle);
  const overrides: DeviceConfig["capabilities"] = {};
  for (const m of members) {
    const sys = await DeviceConfigRegistry.deviceByHandle(m.rid);
    if (sys?.config?.capabilities)
      Object.assign(overrides, sys.config.capabilities);
  }
  // ONE read for the whole member set, since 0063 (`runDetectorRolesForDevices`). This used to be
  // `≈ 2·M·R` SEQUENTIAL round trips — a per-member, per-role existence probe inside this same loop,
  // ~40 of them for a 7-member area, with a short-circuit as the only mitigation.
  const tracked = await runDetectorRolesForDevices(
    members.map((m) => Device.toUuid(m.deviceId)),
  );
  for (const role of tracked) {
    const cap = RUN_TRACKING_CAPABILITY[role as TrackableRoleId];
    if (cap) caps.add(cap);
  }

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
  return satisfies(capabilitiesFromPoints(points), NODE_CATALOG.chart.requires);
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
 * Split out so the seed path (`lib/dashboard/v4-seed.ts`, which resolves that handle to a `dv_`)
 * and the device strategy below share one resolution.
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

/** A device ref the `/device/{id}` renderer must be able to resolve, with its addressing handle. */
export interface StrategyDeviceRef {
  deviceId: DeviceId;
  name: string;
  systemId: number;
}

export interface DeviceStrategyDoc {
  /** The normalized v4 document `/device/{id}` renders. */
  doc: DashboardV4;
  /** Every `dv_` the doc binds — the page device plus any pin — for the renderer's device resolver. */
  devices: StrategyDeviceRef[];
}

/**
 * The default view for `/device/{id}`.
 *
 * 🛑 **The page is DEVICE-scoped, so the document is device-bound — it binds no area.** A device page
 * is not a section over an area, it is a subtree scoped to one device, and the renderer addresses it
 * through the inherited `device` (see `node-view.tsx`'s `area?.handle ?? device?.systemId`) rather
 * than through a synthetic area ref. Consequences:
 *  - no area header — a `heading` group with no resolvable area renders bare;
 *  - `chartCapable` stays undefined, so the collapsed site charts stay hidden here.
 *
 * `device.deviceId` is always present (`devices.id` is the row's own uuid), so unlike the area leg
 * there is no "unresolvable binding" case to degrade. The one pin the strategy can emit — the
 * `oe-grid` card's OE region device — is resolved here and returned so the renderer can address it;
 * an unresolvable pin degrades to "no oe-grid card", the same posture `resolveGridContextForDevice`
 * takes (the grid card is additive and must never break the page).
 */
export async function buildDeviceStrategyDoc(
  device: DeviceRecord,
): Promise<DeviceStrategyDoc> {
  const inputs = await resolveAreaStrategyInputs(device.id);
  const gridHandle = inputs.gridDeviceSystemId;
  const grid =
    gridHandle != null
      ? await DeviceConfigRegistry.deviceByHandle(gridHandle)
      : null;
  const group = buildAreaStrategy({
    capabilities: inputs.capabilities,
    aggregate: inputs.aggregate,
    gridDevice: grid?.deviceId,
    leadWithDeviceMetrics: true,
  });
  const doc = normalizeDocV4({
    version: 4,
    root: {
      kind: "group",
      direction: "column",
      device: device.deviceId,
      children: [group],
    },
  });
  const devices: StrategyDeviceRef[] = [
    {
      deviceId: device.deviceId,
      name: device.displayName,
      systemId: device.id,
    },
  ];
  if (grid) {
    devices.push({
      deviceId: grid.deviceId,
      name: grid.displayName,
      systemId: grid.id,
    });
  }
  return { doc, devices };
}
