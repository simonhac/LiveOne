/**
 * Mondo's "Live usage" payload — `GET /liveusage/widget/{monitoringPointGroupId}`.
 *
 * 🛑 This exists because `/subcircuit/{id}`, the endpoint the poll is built on, carries no battery
 * state of charge, and the adapter recorded that fact as `batterySOC: null` with the comment "Not
 * available from the subcircuit endpoint". That was true of the endpoint and false of the vendor:
 * the platform shows a battery percentage on every page load and it comes from here.
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

  // 🛑 The vendor's OWN timestamp for the sample, not the wall clock. A stalled feed keeps
  // returning its last value; stamping that `Date.now()` would restamp stale data as current every
  // minute, turning the one signal that would reveal the stall into a flat, plausible line.
  const vendorMs = body?.lastRecordedUtc
    ? Date.parse(body.lastRecordedUtc)
    : NaN;

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
    measurementTime: Number.isFinite(vendorMs) ? vendorMs : now,
    dataQuality: "good" as const,
    error: null,
  };
}
