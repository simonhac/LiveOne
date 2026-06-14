/**
 * Chart.js dataset builders for the dashboard charts (chart-generalization phase 2).
 *
 * One builder per visual variant, each consuming the shared `ChartData` contract. Extracted verbatim
 * from the components so the rendering can be shared by a single `<DashboardChart>`. The SoC overlay
 * (single line, or min/max range band + average line for daily data) is handled here too.
 */
import { CHART_COLORS } from "@/lib/chart-colors";
import type { ChartData } from "./types";

/**
 * Stacked-area (site) datasets: power/energy series stacked on the left axis (areas when 5m/30m,
 * bars when daily), with the SoC overlay on the right axis. Only series in `effectiveVisibleSeries`
 * are drawn. Extracted verbatim from SitePowerChart.
 */
export function buildStackedAreaDatasets(
  chartData: ChartData,
  effectiveVisibleSeries: Set<string>,
  isBarChart: boolean,
): any[] {
  // Separate power/energy series from SoC series
  const powerSeries = chartData.series.filter((s) => s.seriesType !== "soc");
  const socSeries = chartData.series.filter((s) => s.seriesType === "soc");

  // Create datasets for power/energy series (stacked)
  const powerDatasets = powerSeries
    .filter((series) => effectiveVisibleSeries.has(series.id))
    .map((series, idx) => {
      const baseConfig = {
        label: series.description,
        data: series.data,
        backgroundColor: series.color,
        yAxisID: "y",
        stack: "stack0",
        order: idx,
      };

      if (isBarChart) {
        return {
          ...baseConfig,
          borderColor: series.color,
          borderWidth: 0,
        };
      } else {
        return {
          ...baseConfig,
          borderColor: series.color,
          tension: 0,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: "stack",
        };
      }
    });

  // Create datasets for SoC series (non-stacked overlay)
  const socDatasets: any[] = [];

  // Find min, avg, max SoC series for daily data
  const socMin = socSeries.find((s) => s.description.includes("(Min)"));
  const socAvg = socSeries.find((s) => s.description.includes("(Avg)"));
  const socMax = socSeries.find((s) => s.description.includes("(Max)"));
  const socLast = socSeries.find(
    (s) => !s.description.includes("(") && s.seriesType === "soc",
  );

  if (isBarChart && socMin && socMax) {
    // Daily data: show min/max range as filled area
    // Match EnergyChart pattern: max dataset fills DOWN to min dataset

    // Add max as upper boundary (fill down to next dataset)
    socDatasets.push({
      label: "Battery SoC Range",
      type: "line" as const,
      data: socMax.data,
      borderColor: "transparent",
      backgroundColor: CHART_COLORS.battery.socRange,
      yAxisID: "y1",
      tension: 0.4, // Smooth curves for range
      borderWidth: 0,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointHitRadius: 0,
      fill: "+1", // Fill to next dataset (min)
      showLine: true,
      order: 10, // Higher number = drawn first (behind bars)
    });

    // Add min as lower boundary (no fill)
    socDatasets.push({
      label: "", // No label (hidden from legend)
      type: "line" as const,
      data: socMin.data,
      borderColor: "transparent",
      backgroundColor: "transparent",
      yAxisID: "y1",
      tension: 0.4, // Smooth curves for range
      borderWidth: 0,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointHitRadius: 0,
      fill: false,
      showLine: true,
      order: 10, // Higher number = drawn first (behind bars)
    });

    // Add average as a line on top
    if (socAvg) {
      socDatasets.push({
        label: "Battery SoC",
        type: "line" as const,
        data: socAvg.data,
        borderColor: CHART_COLORS.battery.soc,
        backgroundColor: CHART_COLORS.battery.soc,
        yAxisID: "y1",
        tension: 0,
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        order: -1, // Negative = drawn last (on top)
      });
    }
  } else if (socLast) {
    // 5m/30m data: show single SoC line
    socDatasets.push({
      label: "Battery SoC",
      data: socLast.data,
      borderColor: CHART_COLORS.battery.soc,
      backgroundColor: "transparent",
      yAxisID: "y1",
      fill: false,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0,
      order: -1,
    });
  }

  return [...powerDatasets, ...socDatasets];
}
