/**
 * Central point DISPLAY registry — the single source of truth for how a device's points are shown
 * (display unit + Excel-style number format). One JSON file per device type; the collector/vendor
 * code stays purely semantic (metricType/metricUnit) and knows nothing about display.
 *
 * A point resolves by `${vendorType}:${subsystem}` → the device manifest, then `physicalPathTail`
 * → its display entry. `subsystem` is the device-type discriminator (e.g. a deepsea system's
 * "generator" points). Adding a device type = drop in a JSON file + one import/entry below.
 *
 * Resolution is done SERVER-SIDE (where the system's vendorType is known); the resolved
 * `{ unit, format }` rides to the client, which just applies the format via applyExcelFormat.
 */

import deepseaGenerator from "@/lib/vendors/deepsea/display/generator.json";

export interface PointDisplay {
  /** display unit, e.g. "V", "Hz", "rpm" */
  unit: string;
  /** Excel-style number format, e.g. "0.0" (see ./excel-format) */
  format: string;
}

type DeviceDisplayManifest = Record<string, PointDisplay>;

/** key = `${vendorType}:${subsystem}` (subsystem = device type) */
const MANIFESTS: Record<string, DeviceDisplayManifest> = {
  "deepsea:generator": deepseaGenerator as DeviceDisplayManifest,
};

/** Resolve a point's display metadata, or null when no manifest covers it. */
export function resolvePointDisplay(
  vendorType: string | null | undefined,
  subsystem: string | null | undefined,
  physicalPathTail: string | null | undefined,
): PointDisplay | null {
  if (!vendorType || !subsystem || !physicalPathTail) return null;
  const manifest = MANIFESTS[`${vendorType}:${subsystem}`];
  return manifest?.[physicalPathTail] ?? null;
}
