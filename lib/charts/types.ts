/**
 * Shared data contract for the dashboard time-series charts (chart-generalization phase 2).
 *
 * `ChartData` is the generic, series-based shape (originally SitePowerChart's): a list of timestamps
 * plus N `SeriesData`, each tagged power/energy (stacked) or soc (overlay). Both the stacked-area and
 * (eventually) the line chart variants render from this one contract. Re-exported from
 * components/SitePowerChart for back-compat with existing importers.
 */

export interface SeriesData {
  id: string;
  description: string;
  data: (number | null)[];
  color: string;
  /** Type of series: power/energy (stacked) or soc (overlay). */
  seriesType?: "power" | "soc";
}

export interface ChartData {
  timestamps: Date[];
  series: SeriesData[];
  mode: "power" | "energy";
}
