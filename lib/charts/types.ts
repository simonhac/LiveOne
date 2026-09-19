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

/**
 * The time span one bar covers, when the bars are NOT evenly spaced.
 *
 * Present only on rolled-up data (today: the Y period's one-bar-per-month view). With it the chart
 * places each bar on the TIME SCALE — `geo.x(start)`…`geo.x(end)` — instead of giving every category
 * an equal `plotWidth / n` slice. That matters because the Y axis' ticks are already month-aligned
 * (`lib/charts/svg/time-ticks.ts`), and calendar months are 28–31 days long: equal-width positional
 * bars would drift up to ~3 weeks away from the tick they belong to by the far end of the year.
 *
 * It also makes a PARTIAL month (the clamped first and last buckets of a trailing window) draw
 * narrower than a whole one, which is the honest cue that its total covers fewer days.
 *
 * Absent ⇒ the positional layout, which is what every evenly-spaced series still wants.
 */
interface BarSpan {
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface ChartData {
  timestamps: Date[];
  series: SeriesData[];
  mode: "power" | "energy";
  /** One per `timestamps` entry when the bars are unevenly spaced — see {@link BarSpan}. */
  barSpans?: BarSpan[];
}

/**
 * The fixed-field shape the line (sidebar) chart uses today (solar/load/battery/grid + SoC). Kept
 * distinct from the generic series-based `ChartData` until the line variant is migrated onto it; the
 * `buildLineDatasets` builder consumes this.
 */
export interface LineChartData {
  timestamps: Date[];
  solar: (number | null)[];
  load: (number | null)[];
  /**
   * Battery power, or `undefined` when the device has no battery-power series — and in energy mode,
   * where there is no battery *energy* series to fetch (`lines-data.ts` nulls it deliberately).
   *
   * Optional, like `grid`, and that symmetry is load-bearing: this used to be a non-optional
   * all-nulls array, which is TRUTHY, so `chartData.batteryW ? …` in the dataset builder always
   * passed and a phantom Battery dataset was added for battery-less devices. In energy mode that was
   * visible — Chart.js allocates a grouped-bar slot per dataset, so the real bars were narrowed and
   * offset by an empty one. Absent means absent.
   */
  batteryW?: (number | null)[];
  batterySOC: (number | null)[];
  batterySOCMin?: (number | null)[]; // Min SOC for daily data
  batterySOCMax?: (number | null)[]; // Max SOC for daily data
  grid?: (number | null)[]; // Grid power/energy (optional - not all devices have grid data)
  mode: "power" | "energy"; // Mode based on interval: power (≤30m) or energy (≥1d)
  /** One per `timestamps` entry when the bars are unevenly spaced — see {@link BarSpan}. */
  barSpans?: BarSpan[];
}

/**
 * Edge-padded SoC min/max band for the line chart's energy (daily) mode.
 *
 * Nullable elements for the same reason as {@link LineChartData}: it is derived from
 * `batterySOCMin`/`batterySOCMax`, which carry nulls wherever a day has no reading.
 */
export interface PaddedSOCData {
  timestamps: Date[];
  min: (number | null)[];
  max: (number | null)[];
}
