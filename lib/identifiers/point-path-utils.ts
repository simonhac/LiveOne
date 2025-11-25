/**
 * Point Path Utilities
 *
 * Utility functions for working with point path strings.
 * A point path has the format: "{type}.{subtype}.{extension}/{metricType}"
 * Or fallback format: "{pointIndex}/{metricType}"
 *
 * Examples:
 * - "source.solar/power"
 * - "bidi.battery.charge/energy"
 * - "load/power" (no subtype/extension)
 * - "5/power" (fallback for points without type)
 */

/**
 * Parsed point path components
 */
export interface ParsedPointPath {
  type: string;
  subtype: string | null;
  extension: string | null;
  metricType: string;
  isFallback: boolean;
  /** Point index if this is a fallback path, null otherwise */
  pointIndex: number | null;
}

/**
 * Build a point path string from type hierarchy and metric type
 *
 * @example
 * buildPointPath("source", "solar", null, "power") // "source.solar/power"
 * buildPointPath("bidi", "battery", "charge", "energy") // "bidi.battery.charge/energy"
 * buildPointPath("load", null, null, "power") // "load/power"
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
 * Build a fallback point path for points without type
 *
 * @example
 * buildFallbackPointPath(5, "power") // "5/power"
 */
export function buildFallbackPointPath(
  pointIndex: number,
  metricType: string,
): string {
  return `${pointIndex}/${metricType}`;
}

/**
 * Parse a point path string into components
 * Returns null if the format is invalid
 *
 * @example
 * parsePointPath("source.solar/power")
 * // { type: "source", subtype: "solar", extension: null, metricType: "power", isFallback: false, pointIndex: null }
 *
 * parsePointPath("5/power")
 * // { type: "5", subtype: null, extension: null, metricType: "power", isFallback: true, pointIndex: 5 }
 */
export function parsePointPath(str: string): ParsedPointPath | null {
  // Must contain exactly one slash
  const slashIndex = str.indexOf("/");
  if (slashIndex === -1 || str.indexOf("/", slashIndex + 1) !== -1) {
    return null;
  }

  const pointIdentifier = str.substring(0, slashIndex);
  const metricType = str.substring(slashIndex + 1);

  // Validate metric type is non-empty
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

  // Parse point identifier (type.subtype.extension)
  const parts = pointIdentifier.split(".");

  if (parts.length === 0 || parts.length > 3) {
    return null;
  }

  // Validate no empty parts
  if (parts.some((p) => !p)) {
    return null;
  }

  return {
    type: parts[0],
    subtype: parts.length > 1 ? parts[1] : null,
    extension: parts.length > 2 ? parts[2] : null,
    metricType,
    isFallback: false,
    pointIndex: null,
  };
}

/**
 * Build a point identifier from parsed components (without metric type)
 *
 * @example
 * buildPointIdentifier("source", "solar", null) // "source.solar"
 * buildPointIdentifier("bidi", "battery", "charge") // "bidi.battery.charge"
 * buildPointIdentifier("load", null, null) // "load"
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
 * Get the point identifier from a ParsedPointPath
 *
 * @example
 * getIdentifierFromParsed({ type: "source", subtype: "solar", ... }) // "source.solar"
 */
export function getIdentifierFromParsed(parsed: ParsedPointPath): string {
  return buildPointIdentifier(parsed.type, parsed.subtype, parsed.extension);
}

/**
 * Get the point identifier part of a path (without the metric type)
 *
 * @example
 * getPointIdentifier("source.solar/power") // "source.solar"
 * getPointIdentifier("bidi.battery.charge/energy") // "bidi.battery.charge"
 * getPointIdentifier("5/power") // "5"
 */
export function getPointIdentifier(path: string): string | null {
  const slashIndex = path.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return path.substring(0, slashIndex);
}

/**
 * Get the metric type from a point path
 *
 * @example
 * getMetricType("source.solar/power") // "power"
 */
export function getMetricType(path: string): string | null {
  const slashIndex = path.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return path.substring(slashIndex + 1) || null;
}

/**
 * Check if a point path matches a given pattern and metric type
 *
 * The pattern can be partial - e.g., "bidi.battery" will match both
 * "bidi.battery/soc" and "bidi.battery.charge/soc"
 *
 * @param path - The full point path to check (e.g., "bidi.battery.charge/power")
 * @param pattern - The pattern to match (e.g., "bidi.battery")
 * @param metricType - The metric type to match (e.g., "power")
 * @returns true if the path matches
 *
 * @example
 * matchesPointPath("bidi.battery/soc", "bidi.battery", "soc") // true
 * matchesPointPath("bidi.battery.charge/power", "bidi.battery", "power") // true
 * matchesPointPath("source.solar/power", "bidi.battery", "power") // false
 */
export function matchesPointPath(
  path: string,
  pattern: string,
  metricType: string,
): boolean {
  const parsed = parsePointPath(path);
  if (!parsed) {
    return false;
  }

  // Check metric type
  if (parsed.metricType !== metricType) {
    return false;
  }

  // Parse the pattern
  const patternParts = pattern.split(".");

  if (patternParts.length === 0 || patternParts.length > 3) {
    return false;
  }

  const patternType = patternParts[0];
  const patternSubtype = patternParts.length > 1 ? patternParts[1] : null;
  const patternExtension = patternParts.length > 2 ? patternParts[2] : null;

  // Check type
  if (parsed.type !== patternType) {
    return false;
  }

  // Check subtype if specified in pattern
  if (patternSubtype !== null && parsed.subtype !== patternSubtype) {
    return false;
  }

  // Check extension if specified in pattern
  if (patternExtension !== null && parsed.extension !== patternExtension) {
    return false;
  }

  return true;
}
