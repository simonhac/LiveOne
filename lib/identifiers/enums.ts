/**
 * The closed vocabularies a series address is built from: the metric a point measures, and the
 * aggregation a stored interval carries.
 *
 * The stem half of an address (`source.solar`, `bidi.battery`, `load`, …) is NOT here — it is owned
 * by the role registry, `lib/roles/registry.ts`, which is what every current caller consults.
 */

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
