import { SystemsManager, SystemWithPolling } from "@/lib/systems-manager";

// Load SystemsManager once at module level
const systemsManager = SystemsManager.getInstance();

/**
 * Utilities for working with series IDs in the format:
 * {systemIdentifier}/{pointPath}/{pointFlavour}
 *
 * Examples:
 * - system.10/bidi.battery/power.avg
 * - kinkora_complete/source.solar/energy.delta
 * - system.3/load.hvac/power.avg
 *
 * Components:
 * - systemIdentifier: Identifies the system (either "system.{id}" or a shortname)
 * - pointPath: type.subtype.extension (e.g., "bidi.battery", "source.solar")
 * - pointFlavour: metricType.aggregation (e.g., "power.avg", "energy.delta")
 *
 * The "series path" (without system prefix) is: {pointPath}/{pointFlavour}
 */

/**
 * Resolve a system identifier to a system
 *
 * @param systemIdentifier - Numeric system ID (e.g., "3" or "10")
 * @returns System or null if not found
 *
 * TODO: Support username.shortname format (e.g., "simon.kinkora_complete") when we have
 * a cheap username lookup mechanism. Currently would require adding a username column
 * to the systems table or calling Clerk API which has rate limits and latency.
 *
 * @example
 * await resolveSystemFromIdentifier("3")
 * // Returns system with id=3
 */
export async function resolveSystemFromIdentifier(
  systemIdentifier: string,
): Promise<SystemWithPolling | null> {
  // Only support numeric ID for now
  if (/^\d+$/.test(systemIdentifier)) {
    return systemsManager.getSystem(parseInt(systemIdentifier));
  }

  return null;
}

/**
 * Build a full series ID from components
 *
 * @param systemIdentifier - System identifier (either "system.{id}" or a shortname)
 * @param pointPath - Point path (e.g., "bidi.battery", "source.solar")
 * @param pointFlavour - Metric type and aggregation (e.g., "power.avg", "energy.delta")
 * @returns Full series ID in format {systemIdentifier}/{pointPath}/{pointFlavour}
 *
 * @example
 * buildSeriesId("system.10", "bidi.battery", "power.avg")
 * // Returns: "system.10/bidi.battery/power.avg"
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
 * Get the site identifier for a system
 *
 * @param system - System to get identifier for
 * @returns Site identifier (shortname if available, otherwise "system.{id}")
 *
 * @example
 * getSiteIdentifier({ id: 10, shortName: "kinkora_complete", ... })
 * // Returns: "kinkora_complete"
 *
 * getSiteIdentifier({ id: 10, shortName: null, ... })
 * // Returns: "system.10"
 */
export function getSiteIdentifier(system: SystemWithPolling): string {
  return system.shortName || `system.${system.id}`;
}

/**
 * Build a siteId from a system
 * @deprecated Use getSiteIdentifier() instead
 */
export function buildSiteIdFromSystem(system: SystemWithPolling): string {
  return getSiteIdentifier(system);
}
