/**
 * Server-side capability resolution — the ELIGIBILITY answer ("which cards CAN this area/device show")
 * derived from CONFIG (`point_info` + trackers + grid context), so it is defined before any reading has
 * arrived. This is the server half of the capability model; the client half is `capabilitiesFromLatest`
 * (runtime presence). Both consume the same registry rule table.
 *
 * ONE entry point for a real device OR an area: `getActivePointsForSystem(handle)` already unions an
 * area's member points (areas-backed → member/bound points; real device → its own), so the ATOMIC
 * capabilities fall straight out of `capabilitiesFromPoints`. COMPOUND capabilities are predicates:
 *  - `generator-running` — any member device has an enabled generator `device_trackers` row.
 *  - `grid-signals`      — the area's location derives a NEM region backed by a seeded OE system
 *                          (`resolveGridContextForSystem`).
 *
 * Server-only (imports the DB/point layer). Do NOT import from a client component — use
 * `capabilitiesFromLatest` there.
 */
import { PointManager } from "@/lib/point/point-manager";
import { SystemsManager } from "@/lib/systems-manager";
import { getAreaForSystem } from "@/lib/areas/resolve";
import { getAreaDeviceSystemIds } from "@/lib/areas/devices";
import { hasEnabledTracker } from "@/lib/run-tracking/resolve";
import { resolveGridContextForSystem } from "@/lib/grid/context";
import { capabilitiesFromPoints } from "@/lib/capabilities/derive";
import {
  applyCapabilityConfig,
  type DeviceConfig,
} from "@/lib/capabilities/config";
import type { CapabilityId } from "@/lib/capabilities/registry";

/** The member systemIds behind a handle: an area's `area_devices`, or the handle itself (a real device). */
export async function memberSystemIds(handle: number): Promise<number[]> {
  const area = await getAreaForSystem(handle);
  if (area) {
    const members = await getAreaDeviceSystemIds(area.id);
    if (members.length) return members;
  }
  return [handle];
}

/**
 * The capability set a handle offers from config. `handle` is a real system id OR an area's
 * `legacy_system_id` — both resolve through `getActivePointsForSystem`.
 */
export async function capabilitiesForSystem(
  handle: number,
): Promise<Set<CapabilityId>> {
  const pm = PointManager.getInstance();
  const sm = SystemsManager.getInstance();
  const points = await pm.getActivePointsForSystem(handle, false, false);
  const caps = capabilitiesFromPoints(points);

  // Walk the member devices once: gather generator-run-tracking + merge their config overrides
  // (later member wins for the same capability). A device's own handle is its own single member.
  const members = await memberSystemIds(handle);
  const mergedOverrides: DeviceConfig["capabilities"] = {};
  let hasGenerator = false;
  for (const sid of members) {
    const sys = await sm.getSystem(sid);
    if (sys?.config?.capabilities)
      Object.assign(mergedOverrides, sys.config.capabilities);
    if (!hasGenerator && (await hasEnabledTracker(sid, "generator")))
      hasGenerator = true;
  }
  if (hasGenerator) caps.add("generator-running");

  // grid-signals: the area's location derives a NEM region + a seeded OE region system.
  if (await resolveGridContextForSystem(handle)) caps.add("grid-signals");

  // Per-device config overrides (no-op when unconfigured — parity preserved).
  return applyCapabilityConfig(caps, { capabilities: mergedOverrides });
}
