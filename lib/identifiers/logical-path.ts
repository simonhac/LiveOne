/**
 * Logical Path Utilities
 *
 * Functions for working with logical paths (the semantic representation of points).
 *
 * Grammar:
 * - logicalPathStem: [A-Za-z0-9_-]+ segments separated by "." (nullable)
 *   Examples: "source.solar", "bidi.battery.charge", "load"
 *
 * - metricType: [A-Za-z0-9_-]+
 *   Examples: "power", "energy", "soc"
 *
 * - logicalPath (computed): logicalPathStem + "/" + metricType
 *   Examples: "source.solar/power", "bidi.battery.charge/energy"
 */

// Validation patterns
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const LOGICAL_PATH_STEM_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * Validate a logical path stem (segments separated by ".")
 *
 * @example
 * isValidLogicalPathStem("source.solar") // true
 * isValidLogicalPathStem("bidi.battery.charge") // true
 * isValidLogicalPathStem("load") // true (single segment)
 * isValidLogicalPathStem("") // false
 * isValidLogicalPathStem("foo.") // false
 */
export function isValidLogicalPathStem(stem: string): boolean {
  return LOGICAL_PATH_STEM_PATTERN.test(stem);
}

/**
 * Validate a metric type (single segment)
 *
 * @example
 * isValidMetricType("power") // true
 * isValidMetricType("energy") // true
 * isValidMetricType("soc") // true
 * isValidMetricType("") // false
 * isValidMetricType("foo.bar") // false
 */
export function isValidMetricType(type: string): boolean {
  return SEGMENT_PATTERN.test(type);
}

/**
 * Validate a full logical path (stem + "/" + metricType)
 *
 * @example
 * isValidLogicalPath("source.solar/power") // true
 * isValidLogicalPath("load/power") // true
 * isValidLogicalPath("power") // false (no slash)
 */
export function isValidLogicalPath(path: string): boolean {
  const slashIndex = path.indexOf("/");
  if (slashIndex === -1 || slashIndex === 0 || slashIndex === path.length - 1) {
    return false;
  }

  const stem = path.substring(0, slashIndex);
  const metricType = path.substring(slashIndex + 1);

  // Must have exactly one slash
  if (metricType.includes("/")) {
    return false;
  }

  return isValidLogicalPathStem(stem) && isValidMetricType(metricType);
}

/**
 * Get the logical path stem from a full logical path
 *
 * @example
 * getLogicalPathStem("source.solar/power") // "source.solar"
 * getLogicalPathStem("load/power") // "load"
 * getLogicalPathStem("invalid") // null
 */
export function getLogicalPathStem(path: string): string | null {
  const slashIndex = path.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return path.substring(0, slashIndex) || null;
}

/**
 * Get the metric type from a full logical path
 *
 * @example
 * getMetricType("source.solar/power") // "power"
 * getMetricType("load/energy") // "energy"
 * getMetricType("invalid") // null
 */
export function getMetricType(path: string | null | undefined): string | null {
  if (!path) return null;
  const slashIndex = path.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return path.substring(slashIndex + 1) || null;
}

/**
 * Split a logical path into its stem segments
 *
 * Combines getLogicalPathStem() and split(".") into one call.
 * Returns empty array for invalid paths (safe to index).
 *
 * @example
 * stemSplit("source.solar/power") // ["source", "solar"]
 * stemSplit("bidi.battery.charge/soc") // ["bidi", "battery", "charge"]
 * stemSplit("load/power") // ["load"]
 * stemSplit("invalid") // []
 * stemSplit(null) // []
 */
export function stemSplit(path: string | null | undefined): string[] {
  if (!path) return [];
  const stem = getLogicalPathStem(path);
  if (!stem) return [];
  return stem.split(".");
}

/**
 * Build a full logical path from stem and metric type
 *
 * @example
 * buildLogicalPath("source.solar", "power") // "source.solar/power"
 * buildLogicalPath(null, "power") // null
 */
export function buildLogicalPath(
  stem: string | null,
  metricType: string,
): string | null {
  if (!stem) return null;
  return `${stem}/${metricType}`;
}

/**
 * Check if a logical path matches a given stem pattern and metric type
 *
 * The pattern can be partial - e.g., "bidi.battery" will match both
 * "bidi.battery/soc" and "bidi.battery.charge/soc"
 *
 * @param logicalPath - The full logical path to check (e.g., "bidi.battery.charge/power")
 * @param stemPattern - The stem pattern to match (e.g., "bidi.battery")
 * @param metricType - The metric type to match (e.g., "power")
 * @returns true if the path matches
 *
 * @example
 * matchesLogicalPath("bidi.battery/soc", "bidi.battery", "soc") // true
 * matchesLogicalPath("bidi.battery.charge/power", "bidi.battery", "power") // true
 * matchesLogicalPath("source.solar/power", "bidi.battery", "power") // false
 */
export function matchesLogicalPath(
  logicalPath: string | null | undefined,
  stemPattern: string,
  metricType: string,
): boolean {
  if (!logicalPath) return false;

  const pathMetricType = getMetricType(logicalPath);
  if (pathMetricType !== metricType) {
    return false;
  }

  const pathStem = getLogicalPathStem(logicalPath);
  if (!pathStem) {
    return false;
  }

  // Check if the path stem starts with the pattern
  // The pattern can be a prefix (e.g., "bidi.battery" matches "bidi.battery.charge")
  if (pathStem === stemPattern) {
    return true;
  }

  // Check if pattern is a prefix of the stem (must be followed by ".")
  if (pathStem.startsWith(stemPattern + ".")) {
    return true;
  }

  return false;
}
