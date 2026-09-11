/**
 * Enums for known identifier values
 *
 * These enums provide type safety for common point types, metric types,
 * and aggregation fields used throughout the system.
 */

/**
 * Known point types
 */
export enum PointType {
  SOURCE = "source",
  BIDI = "bidi",
  LOAD = "load",
  GRID = "grid",
}

/**
 * Known point subtypes
 */
export enum PointSubtype {
  // Source subtypes
  SOLAR = "solar",
  WIND = "wind",
  HYDRO = "hydro",

  // Bidi subtypes
  BATTERY = "battery",

  // Load subtypes
  HVAC = "hvac",
  HOT_WATER = "hot_water",
  EV = "ev",
  POOL = "pool",
  MANAGED = "managed",
  UNMANAGED = "unmanaged",
}

/**
 * Known point extensions
 */
export enum PointExtension {
  CHARGE = "charge",
  DISCHARGE = "discharge",
  LOCAL = "local",
}

/**
 * Metric types — the closed vocabulary a logical path's metric segment may take.
 *
 * A vocabulary is complete or it is wrong. Members with no `MetricType.X` reference are still
 * consumed as the string literals they equal (`"power"`, `"voltage"`, …) at the path and API
 * boundaries, so deleting one would delete a valid value, not dead code. knip is told to skip
 * `enumMembers` for this file — see knip.jsonc.
 */
export enum MetricType {
  POWER = "power",
  ENERGY = "energy",
  SOC = "soc",
  VOLTAGE = "voltage",
  CURRENT = "current",
  FREQUENCY = "frequency",
  TEMPERATURE = "temperature",
}

/**
 * Aggregation fields for time-series data.
 *
 * Closed vocabulary — see {@link MetricType}.
 */
export enum AggregationField {
  AVG = "avg",
  MIN = "min",
  MAX = "max",
  LAST = "last",
  DELTA = "delta",
  SUM = "sum",
  QUALITY = "quality",
}
