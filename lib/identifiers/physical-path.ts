/**
 * Physical Path Utilities
 *
 * Functions for working with physical paths (MQTT-style paths).
 *
 * Grammar:
 * - physicalPath: [A-Za-z0-9_-]+ segments separated by "/" (MQTT-friendly)
 *   Examples: "selectronic/solar_w", "E1/kwh"
 */

// Validation pattern
const PHYSICAL_PATH_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/**
 * Validate a physical path (segments separated by "/")
 *
 * @example
 * isValidPhysicalPath("selectronic/solar_w") // true
 * isValidPhysicalPath("E1/kwh") // true
 * isValidPhysicalPath("selectronic") // true (single segment)
 * isValidPhysicalPath("") // false
 * isValidPhysicalPath("foo/") // false
 */
export function isValidPhysicalPath(path: string): boolean {
  return PHYSICAL_PATH_PATTERN.test(path);
}

/**
 * Split a physical path into segments
 *
 * @example
 * splitPhysicalPath("selectronic/solar_w") // ["selectronic", "solar_w"]
 * splitPhysicalPath("E1") // ["E1"]
 */
export function splitPhysicalPath(path: string): string[] {
  return path.split("/");
}
