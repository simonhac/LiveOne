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
 * Utilities for working with series paths in the format:
 * liveone.{siteId}.{pointId}
 *
 * Examples:
 * - liveone.system.10.bidi.battery
 * - liveone.kinkora_complete.source.solar
 * - liveone.daylesford.load
 *
 * Components:
 * - network: Always "liveone"
 * - siteId: Identifies the system (either "system.{id}" or a shortname)
 * - pointId: Identifies the measurement/capability (e.g., "bidi.battery", "source.solar")
 *
 * Note: Pure parsing functions are re-exported from series-path-parser.ts above
 */

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
 * Build a full series path from components
 *
 * @param siteId - Site identifier (either "system.{id}" or a shortname)
 * @param pointId - Point identifier (e.g., "bidi.battery", "source.solar")
 * @param network - Network name (defaults to "liveone")
 * @returns Full series path
 *
 * @example
 * buildSeriesPath("system.10", "bidi.battery")
 * // Returns: "liveone.system.10.bidi.battery"
 *
 * buildSeriesPath("kinkora_complete", "source.solar")
 * // Returns: "liveone.kinkora_complete.source.solar"
 */
export function buildSeriesPath(
  siteId: string,
  pointId: string,
  network: string = "liveone",
): string {
  return `${network}.${siteId}.${pointId}`;
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
