/**
 * Point Path Utilities
 *
 * Utility functions for working with point paths.
 *
 * Grammar:
 * - physicalPath: [A-Za-z0-9_-]+ segments separated by "/" (MQTT-friendly)
 *   Examples: "selectronic/solar_w", "E1/kwh"
 *
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
const PHYSICAL_PATH_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const LOGICAL_PATH_STEM_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

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

/**
 * Split a logical path stem into segments
 *
 * @example
 * splitLogicalPathStem("source.solar") // ["source", "solar"]
 * splitLogicalPathStem("bidi.battery.charge") // ["bidi", "battery", "charge"]
 */
export function splitLogicalPathStem(stem: string): string[] {
  return stem.split(".");
}

// ============================================================================
// DEPRECATED - These functions are kept for backward compatibility during
// migration but should not be used in new code.
// ============================================================================

/**
 * @deprecated Use logicalPathStem and metricType directly
 */
export interface ParsedPointPath {
  type: string;
  subtype: string | null;
  extension: string | null;
  metricType: string;
  isFallback: boolean;
  pointIndex: number | null;
}

/**
 * @deprecated Use buildLogicalPath() instead
 */
export function buildPointPath(
  type: string,
  subtype: string | null,
  extension: string | null,
  metricType: string,
): string {
  let path = type;
  if (subtype) {
    path += `.${subtype}`;
    if (extension) {
      path += `.${extension}`;
    }
  }
  return `${path}/${metricType}`;
}

/**
 * @deprecated Use index-based fallback in point.getLogicalPath()
 */
export function buildFallbackPointPath(
  pointIndex: number,
  metricType: string,
): string {
  return `${pointIndex}/${metricType}`;
}

/**
 * @deprecated Use getLogicalPathStem() and getMetricType() instead
 */
export function parsePointPath(
  str: string | null | undefined,
): ParsedPointPath | null {
  if (!str) return null;

  const slashIndex = str.indexOf("/");
  if (slashIndex === -1 || str.indexOf("/", slashIndex + 1) !== -1) {
    return null;
  }

  const pointIdentifier = str.substring(0, slashIndex);
  const metricType = str.substring(slashIndex + 1);

  if (!metricType) {
    return null;
  }

  // Check if this is a numeric-only point index (fallback format)
  if (/^\d+$/.test(pointIdentifier)) {
    const pointIndex = parseInt(pointIdentifier, 10);
    if (pointIndex > 0) {
      return {
        type: pointIdentifier,
        subtype: null,
        extension: null,
        metricType,
        isFallback: true,
        pointIndex,
      };
    }
    return null;
  }

  // Parse point identifier - now supports unlimited segments
  const parts = pointIdentifier.split(".");

  if (parts.length === 0 || parts.some((p) => !p)) {
    return null;
  }

  return {
    type: parts[0],
    subtype: parts.length > 1 ? parts[1] : null,
    extension: parts.length > 2 ? parts.slice(2).join(".") : null,
    metricType,
    isFallback: false,
    pointIndex: null,
  };
}

/**
 * @deprecated Construct stems directly as strings
 */
export function buildPointIdentifier(
  type: string,
  subtype: string | null,
  extension: string | null,
): string {
  let path = type;
  if (subtype) {
    path += `.${subtype}`;
    if (extension) {
      path += `.${extension}`;
    }
  }
  return path;
}

/**
 * @deprecated Use getLogicalPathStem() instead
 */
export function getPointIdentifier(path: string): string | null {
  return getLogicalPathStem(path);
}

/**
 * @deprecated Use getLogicalPathStem() instead
 */
export function getIdentifierFromParsed(parsed: ParsedPointPath): string {
  return buildPointIdentifier(parsed.type, parsed.subtype, parsed.extension);
}

/**
 * @deprecated Use matchesLogicalPath() instead
 */
export function matchesPointPath(
  path: string,
  pattern: string,
  metricType: string,
): boolean {
  return matchesLogicalPath(path, pattern, metricType);
}
