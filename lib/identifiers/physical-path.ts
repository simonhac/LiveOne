/**
 * Physical Path Tail Utilities
 *
 * Functions for working with physical path tails (MQTT-style path suffixes).
 *
 * Full MQTT topic structure: liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}
 *
 * Grammar:
 * - physicalPathTail: [A-Za-z0-9_-]+ segments separated by "/" (MQTT-friendly)
 *   Examples: "solar_w", "batterySOC", "B1/kwh"
 */

// Validation pattern
const PHYSICAL_PATH_TAIL_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/**
 * Validate a physical path tail (segments separated by "/")
 *
 * @example
 * isValidPhysicalPathTail("solar_w") // true
 * isValidPhysicalPathTail("B1/kwh") // true
 * isValidPhysicalPathTail("batterySOC") // true (single segment)
 * isValidPhysicalPathTail("") // false
 * isValidPhysicalPathTail("foo/") // false
 */
export function isValidPhysicalPathTail(path: string): boolean {
  return PHYSICAL_PATH_TAIL_PATTERN.test(path);
}

/**
 * Split a physical path tail into segments
 *
 * @example
 * splitPhysicalPathTail("B1/kwh") // ["B1", "kwh"]
 * splitPhysicalPathTail("solar_w") // ["solar_w"]
 */
export function splitPhysicalPathTail(path: string): string[] {
  return path.split("/");
}

// Legacy aliases for backwards compatibility
export const isValidPhysicalPath = isValidPhysicalPathTail;
export const splitPhysicalPath = splitPhysicalPathTail;
