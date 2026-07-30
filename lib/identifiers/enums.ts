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
 * Metric types
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
 * Aggregation fields for time-series data
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

/**
 * Type guard to check if a string is a valid PointType
 */
export function isPointType(value: string): value is PointType {
  return Object.values(PointType).includes(value as PointType);
}

/**
 * Type guard to check if a string is a valid MetricType
 */
export function isMetricType(value: string): value is MetricType {
  return Object.values(MetricType).includes(value as MetricType);
}

/**
 * Type guard to check if a string is a valid AggregationField
 */
export function isAggregationField(value: string): value is AggregationField {
  return Object.values(AggregationField).includes(value as AggregationField);
}
