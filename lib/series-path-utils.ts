import { SystemsManager, SystemWithPolling } from "@/lib/systems-manager";

// Re-export pure parsing functions from series-path-parser
// These can be used in both client and server components
export {
  parseSeriesPath,
  parseDeviceMetric,
  parseDeviceId,
  type ParsedSeriesPath,
  type ParsedDeviceMetric,
  type ParsedDeviceId,
} from "./series-path-parser";

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
 *
 * Note: Pure parsing functions are re-exported from series-path-parser.ts above
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
 * Resolve a siteId to a system
 *
 * @param siteId - Site identifier (either "system.{id}" or a shortname)
 * @returns System or null if not found
 *
 * @example
 * await resolveSystemFromSiteId("system.10")
 * // Returns system with id=10
 *
 * await resolveSystemFromSiteId("kinkora_complete")
 * // Returns system with shortName="kinkora_complete"
 */
export async function resolveSystemFromSiteId(
  siteId: string,
): Promise<SystemWithPolling | null> {
  // Check if it's in "system.{id}" format
  if (siteId.startsWith("system.")) {
    const systemIdStr = siteId.split(".")[1];
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return null;
    }

    return systemsManager.getSystem(systemId);
  }

  // It's a shortname - search all systems
  const allSystems = await systemsManager.getAllSystems();
  return allSystems.find((s) => s.shortName === siteId) || null;
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
 * Build a siteId from a system
 *
 * @param system - System to build siteId for
 * @returns Site identifier (shortname if available, otherwise "system.{id}")
 *
 * @example
 * buildSiteIdFromSystem({ id: 10, shortName: "kinkora_complete", ... })
 * // Returns: "kinkora_complete"
 *
 * buildSiteIdFromSystem({ id: 10, shortName: null, ... })
 * // Returns: "system.10"
 */
export function buildSiteIdFromSystem(system: SystemWithPolling): string {
  return system.shortName || `system.${system.id}`;
}

/**
 * Extract system ID from a siteId
 * Handles both "system.{id}" format and shortnames
 *
 * @param siteId - Site identifier
 * @param allSystems - Pre-loaded array of all systems
 * @returns System ID or null if not found
 *
 * @example
 * extractSystemIdFromSiteId("system.10", systems)
 * // Returns: 10
 *
 * extractSystemIdFromSiteId("kinkora_complete", systems)
 * // Returns: 11 (if that's the system with shortName="kinkora_complete")
 */
export async function extractSystemIdFromSiteId(
  siteId: string,
  allSystems: SystemWithPolling[],
): Promise<number | null> {
  // Check if it's in "system.{id}" format
  if (siteId.startsWith("system.")) {
    const systemIdStr = siteId.split(".")[1];
    const systemId = parseInt(systemIdStr);
    return isNaN(systemId) ? null : systemId;
  }

  // It's a shortname - resolve to system ID
  const system = await resolveSystemFromSiteId(siteId);
  return system ? system.id : null;
}
