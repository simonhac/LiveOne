/**
 * Mondo's "Live usage" payload — `GET /liveusage/widget/{monitoringPointGroupId}`.
 *
 * 🛑 This exists because `/subcircuit/{id}`, the endpoint the poll is built on, carries no battery
 * state of charge, and the adapter recorded that fact as `batterySOC: null` with the comment "Not
 * available from the subcircuit endpoint". That was true of the endpoint and false of the vendor:
 * the platform shows a battery percentage on every page load and it comes from here.
 *
 * 🛑 It carries a SECOND thing `/subcircuit/` cannot produce: `demand`, the vendor's own computed
 * SITE LOAD. `/subcircuit/` enumerates monitored CIRCUITS — EV, pool, HVAC, hot water — and the sum
 * of those is not the site's load, because an unmonitored circuit contributes to demand and to no
 * subcircuit. Mondo computes the real figure and returns it here. Without it, device 6 had no
 * `load/power` at all and the Kinkora area's whole-of-site load could only come from the Fronius.
 *
 * 🛑 The URL takes the monitoring point GROUP id, not a monitoring point id. A point id returns
 * **403**, not 404, so getting it wrong reads as a permissions problem rather than a wrong address.
 * `devices.vendor_site_id` is already the group id — it is what `/subcircuit/` is keyed by too.
 *
 * The parsing is separated from the fetching so it can be tested against real payloads without a
 * network, the same way `point-metadata.ts` is elsewhere in this tree.
 */
import type { PointReadingInput } from "../types";

/** The shape we care about. Everything is optional: a battery-less site omits most of it. */
export interface MondoLiveUsage {
  /** Site load, in KILOWATTS. See `siteLoadReading` — everything downstream is watts. */
  demand?: number;
  lastRecordedUtc?: string;
  liveUsageData?: {
    battery?: { value?: number; stateOfCharge?: number; deviceStatus?: string };
    generator?: { value?: number; deviceStatus?: string };
    grid?: { value?: number; deviceStatus?: string };
    solar?: { value?: number; deviceStatus?: string };
  };
}

/**
 * The sample's own timestamp, falling back to `now`.
 *
 * 🛑 The vendor's OWN timestamp for the sample, not the wall clock. A stalled feed keeps returning
 * its last value; stamping that `Date.now()` would restamp stale data as current every minute,
 * turning the one signal that would reveal the stall into a flat, plausible line.
 */
function sampleTime(body: MondoLiveUsage | null | undefined, now: number) {
  const vendorMs = body?.lastRecordedUtc
    ? Date.parse(body.lastRecordedUtc)
    : NaN;
  return Number.isFinite(vendorMs) ? vendorMs : now;
}

/**
 * The battery SoC reading carried by a live-usage payload, or null if it carries none.
 *
 * `now` is injected so the fallback path is testable; callers pass `Date.now()`.
 */
export function batterySocReading(
  body: MondoLiveUsage | null | undefined,
  now: number,
): PointReadingInput | null {
  const soc = body?.liveUsageData?.battery?.stateOfCharge;
  // 🛑 `typeof`, never truthiness. A genuine 0% — a flat battery, the reading that matters most —
  // is falsy, and discarding it would blind us exactly when the number counts.
  if (typeof soc !== "number" || !Number.isFinite(soc)) return null;

  const vendorMs = sampleTime(body, now);

  return {
    pointMetadata: {
      physicalPathTail: "battery_soc",
      logicalPathStem: "bidi.battery",
      defaultName: "Battery",
      subsystem: "battery",
      metricType: "soc",
      metricUnit: "%",
      transform: null,
    },
    rawValue: soc,
    measurementTime: vendorMs,
    dataQuality: "good" as const,
    error: null,
  };
}

/**
 * The site-load reading carried by a live-usage payload, or null if it carries none.
 *
 * 🛑 `demand` is in KILOWATTS and every power point in LiveOne is WATTS. The adapter's own
 * device-discovery path already multiplies by 1000 with a `// kW to W` comment; getting it wrong
 * gives a number that is plausible and 1000× out.
 *
 * 🛑 `typeof`, never truthiness — same reason as the SoC above. A genuine 0 W is what an
 * off-grid-at-idle or a fully-exporting site reads, and it is falsy.
 */
export function siteLoadReading(
  body: MondoLiveUsage | null | undefined,
  now: number,
): PointReadingInput | null {
  const demandKw = body?.demand;
  if (typeof demandKw !== "number" || !Number.isFinite(demandKw)) return null;

  return {
    pointMetadata: {
      // The unit is in the name because the wire and the store disagree about it: the vendor sends
      // kW here and the point stores W. A reader comparing an archived payload against a stored
      // value needs that told to them. (`derivePointUid` hashes this, so it is permanent.)
      physicalPathTail: "site_load_w",
      logicalPathStem: "load",
      // "Site Load", not "Load": device 6's other load points are CIRCUITS (`load.ev`, `load.pool`,
      // `load.hvac`, `load.hws`) and this is deliberately not their sum — see the header.
      defaultName: "Site Load",
      subsystem: "load",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
    rawValue: demandKw * 1000,
    measurementTime: sampleTime(body, now),
    dataQuality: "good" as const,
    error: null,
  };
}

/**
 * Every reading a live-usage payload carries. One request, so one place to add the next one.
 *
 * Each is independently optional: a battery-less site still reports demand, and a payload that
 * omits both yields an empty array rather than a failure. The caller treats the whole fetch as
 * best-effort anyway.
 */
export function liveUsageReadings(
  body: MondoLiveUsage | null | undefined,
  now: number,
): PointReadingInput[] {
  return [batterySocReading(body, now), siteLoadReading(body, now)].filter(
    (r): r is PointReadingInput => r !== null,
  );
}
