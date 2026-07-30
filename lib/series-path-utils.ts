import {
  DeviceConfigRegistry,
  type DeviceConfigView,
} from "@/lib/registry/device-config";

/**
 * Utilities for working with series IDs in the format:
 * {systemIdentifier}/{pointPath}/{pointFlavour}
 *
 * Examples:
 * - device.10/bidi.battery/power.avg
 * - kinkora_complete/source.solar/energy.delta
 * - device.3/load.hvac/power.avg
 *
 * Components:
 * - systemIdentifier: Identifies the device (either "device.{id}" or a shortname)
 * - pointPath: type.subtype.extension (e.g., "bidi.battery", "source.solar")
 * - pointFlavour: metricType.aggregation (e.g., "power.avg", "energy.delta")
 *
 * The "series path" (without device prefix) is: {pointPath}/{pointFlavour}
 */

/**
 * Resolve a device identifier to a device
 *
 * @param systemIdentifier - Numeric device ID (e.g., "3" or "10")
 * @returns Device or null if not found
 *
 * TODO: Support username.shortname format (e.g., "simon.kinkora_complete") when we have
 * a cheap username lookup mechanism. Currently would require adding a username column
 * to the devices table or calling Clerk API which has rate limits and latency.
 *
 * @example
 * await resolveDeviceFromIdentifier("3")
 * // Returns device with id=3
 */
export async function resolveDeviceFromIdentifier(
  systemIdentifier: string,
): Promise<DeviceConfigView | null> {
  // Only support numeric ID for now
  if (/^\d+$/.test(systemIdentifier)) {
    return DeviceConfigRegistry.deviceByHandle(parseInt(systemIdentifier));
  }

  return null;
}

/**
 * Build a full series ID from components
 *
 * @param systemIdentifier - Device identifier (either "device.{id}" or a shortname)
 * @param pointPath - Point path (e.g., "bidi.battery", "source.solar")
 * @param pointFlavour - Metric type and aggregation (e.g., "power.avg", "energy.delta")
 * @returns Full series ID in format {systemIdentifier}/{pointPath}/{pointFlavour}
 *
 * @example
 * buildSeriesId("device.10", "bidi.battery", "power.avg")
 * // Returns: "device.10/bidi.battery/power.avg"
 *
 * buildSeriesId("kinkora_complete", "source.solar", "energy.delta")
 * // Returns: "kinkora_complete/source.solar/energy.delta"
 */
export function buildSeriesId(
  systemIdentifier: string,
  pointPath: string,
  pointFlavour: string,
): string {
  return `${systemIdentifier}/${pointPath}/${pointFlavour}`;
}

/**
 * Get the site identifier for a device
 *
 * @param device - Device to get identifier for
 * @returns Site identifier (shortname if available, otherwise "device.{id}")
 *
 * @example
 * getSiteIdentifier({ id: 10, alias: "kinkora_complete", ... })
 * // Returns: "kinkora_complete"
 *
 * getSiteIdentifier({ id: 10, alias: null, ... })
 * // Returns: "device.10"
 */
export function getSiteIdentifier(device: DeviceConfigView): string {
  return device.alias || `system.${device.id}`;
}

/**
 * Build a siteId from a device
 * @deprecated Use getSiteIdentifier() instead
 */
export function buildSiteIdFromDevice(device: DeviceConfigView): string {
  return getSiteIdentifier(device);
}
