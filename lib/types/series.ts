/**
 * Information about a supported series for a system
 * Includes both user-facing information and database mapping
 */
export interface SeriesInfo {
  /** Full series ID (e.g., "system.10/bidi.battery/power.avg") */
  id: string;

  /** Intervals that support this series */
  intervals: ("5m" | "1d")[];

  /** Human-readable label */
  label: string;

  /** Metric unit (e.g., "W", "Wh", "%") */
  metricUnit: string;

  /** System ID */
  systemId: number;

  /** Point ID (also called pointIndex) */
  pointIndex: number;

  /** Column name in the aggregation table (e.g., "avg", "delta", "min", "max") */
  column: string;
}
