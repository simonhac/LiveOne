/**
 * Shared data contract for the dashboard time-series charts (chart-generalization phase 2).
 *
 * `ChartData` is the generic, series-based shape (the stacked/site contract): a list of timestamps
 * plus N `SeriesData`, each tagged power/energy (stacked) or soc (overlay). The stacked-area chart
 * renders from this; the line chart uses `LineChartData` below. The canonical home for both.
 */

export interface SeriesData {
  id: string;
  description: string;
  data: (number | null)[];
  color: string;
  /** Type of series: power/energy (stacked) or soc (overlay). */
  seriesType?: "power" | "soc";
  /** Canonical `source.*`/`load.*` node id this series maps to in the attributed flow matrix
   *  (`DailyFlowMatrices`), when it maps to one. Resolved upstream by `flowPathForSeries` because the
   *  series id alone is ambiguous — grid export (load) and grid import (generation) share one id —
   *  so the legend table can look up per-row cost/emissions without re-deriving the mapping. */
  flowPath?: string;
}

export interface ChartData {
  timestamps: Date[];
  series: SeriesData[];
  mode: "power" | "energy";
}

/**
 * The fixed-field shape the line (sidebar) chart uses today (solar/load/battery/grid + SoC). Kept
 * distinct from the generic series-based `ChartData` until the line variant is migrated onto it; the
 * `buildLineDatasets` builder consumes this.
 */
export interface LineChartData {
  timestamps: Date[];
  solar: number[];
  load: number[];
  batteryW: number[];
  batterySOC: number[];
  batterySOCMin?: number[]; // Min SOC for daily data
  batterySOCMax?: number[]; // Max SOC for daily data
  grid?: number[]; // Grid power/energy (optional - not all devices have grid data)
  mode: "power" | "energy"; // Mode based on interval: power (≤30m) or energy (≥1d)
}

/** Edge-padded SoC min/max band for the line chart's energy (daily) mode. */
export interface PaddedSOCData {
  timestamps: Date[];
  min: number[];
  max: number[];
}
