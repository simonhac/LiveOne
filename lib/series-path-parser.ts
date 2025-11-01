/**
 * Pure parsing utilities for series paths
 * These functions have no server-side dependencies and can be used in client components
 */

export interface ParsedSeriesPath {
  network: string;
  siteId: string;
  pointId: string;
  fullPath: string;
}

export interface ParsedDeviceMetric {
  deviceId: string; // e.g., "load", "bidi.battery", "source.solar.local"
  metric: string; // e.g., "power", "soc", "temperature"
  summariser?: string; // e.g., "avg", "last", "min", "max"
}

export interface ParsedDeviceId {
  type: string; // e.g., "load", "bidi", "source"
  subtype?: string; // e.g., "battery", "solar"
  extension?: string; // e.g., "local", "remote"
}

/**
 * Parse a full series path into its components
 *
 * @param fullPath - Full path like "liveone.system.10.bidi.battery"
 * @returns Parsed components or null if invalid
 *
 * @example
 * parseSeriesPath("liveone.system.10.bidi.battery")
 * // Returns: { network: "liveone", siteId: "system.10", pointId: "bidi.battery", fullPath: "..." }
 *
 * parseSeriesPath("liveone.kinkora.source.solar")
 * // Returns: { network: "liveone", siteId: "kinkora", pointId: "source.solar", fullPath: "..." }
 */
export function parseSeriesPath(fullPath: string): ParsedSeriesPath | null {
  const parts = fullPath.split(".");

  if (parts.length < 3 || parts[0] !== "liveone") {
    return null;
  }

  let siteId: string;
  let seriesIdStartIndex: number;

  // Check if siteId is in "system.{id}" format
  if (parts[1] === "system") {
    if (parts.length < 4) {
      return null; // Need at least liveone.system.{id}.{pointId}
    }
    siteId = `${parts[1]}.${parts[2]}`; // "system.10"
    seriesIdStartIndex = 3;
  } else {
    // It's a shortname
    siteId = parts[1]; // "fronius", "kinkora", etc.
    seriesIdStartIndex = 2;
  }

  const pointId = parts.slice(seriesIdStartIndex).join(".");

  return {
    network: parts[0],
    siteId,
    pointId,
    fullPath,
  };
}

// Known summariser types
const KNOWN_SUMMARISERS = new Set([
  "avg",
  "last",
  "min",
  "max",
  "sum",
  "count",
  "first",
]);

/**
 * Parse deviceId, metric, and summariser from a pointId
 *
 * @param pointId - Point identifier (e.g., "bidi.battery.power.avg", "load.power", "source.solar.local.power.avg")
 * @returns Parsed components or null if invalid
 *
 * @example
 * parseDeviceMetric("bidi.battery.power.avg")
 * // Returns: { deviceId: "bidi.battery", metric: "power", summariser: "avg" }
 *
 * parseDeviceMetric("load.power")
 * // Returns: { deviceId: "load", metric: "power", summariser: undefined }
 *
 * parseDeviceMetric("source.solar.local.power.avg")
 * // Returns: { deviceId: "source.solar.local", metric: "power", summariser: "avg" }
 */
export function parseDeviceMetric(pointId: string): ParsedDeviceMetric | null {
  const parts = pointId.split(".");

  if (parts.length < 2) {
    return null; // Need at least deviceType and metric
  }

  let summariser: string | undefined;
  let metric: string;
  let deviceIdParts: string[];

  // Check if last part is a known summariser
  if (KNOWN_SUMMARISERS.has(parts[parts.length - 1])) {
    if (parts.length < 3) {
      return null; // Need at least deviceType, metric, and summariser
    }
    summariser = parts[parts.length - 1];
    metric = parts[parts.length - 2];
    deviceIdParts = parts.slice(0, -2);
  } else {
    // No summariser
    metric = parts[parts.length - 1];
    deviceIdParts = parts.slice(0, -1);
  }

  if (deviceIdParts.length === 0) {
    return null;
  }

  const deviceId = deviceIdParts.join(".");

  return {
    deviceId,
    metric,
    summariser,
  };
}

/**
 * Parse a deviceId into type, subtype, and optional extension
 *
 * @param deviceId - Device identifier (e.g., "load", "bidi.battery", "source.solar.local")
 * @returns Parsed components or null if invalid
 *
 * @example
 * parseDeviceId("load")
 * // Returns: { type: "load" }
 *
 * parseDeviceId("bidi.battery")
 * // Returns: { type: "bidi", subtype: "battery" }
 *
 * parseDeviceId("source.solar.local")
 * // Returns: { type: "source", subtype: "solar", extension: "local" }
 */
export function parseDeviceId(deviceId: string): ParsedDeviceId | null {
  const parts = deviceId.split(".");

  if (parts.length === 0) {
    return null;
  }

  const type = parts[0];
  const subtype = parts.length >= 2 ? parts[1] : undefined;
  const extension = parts.length >= 3 ? parts.slice(2).join(".") : undefined;

  return {
    type,
    subtype,
    extension,
  };
}
