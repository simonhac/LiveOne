/**
 * Chart.js dataset builders for the dashboard charts (chart-generalization phase 2).
 *
 * One builder per visual variant, each consuming the shared `ChartData` contract. Extracted verbatim
 * from the components so the rendering can be shared by a single `<DashboardChart>`. The SoC overlay
 * (single line, or min/max range band + average line for daily data) is handled here too.
 */
import { CHART_COLORS } from "@/lib/chart-colors";
import type { ChartData, LineChartData, PaddedSOCData } from "./types";

/**
 * Dash pattern for the Battery SoC trace, exported so the legend swatch can mirror it exactly.
 *
 * SoC needs it because `CHART_COLORS.battery.soc` and `.main` are the same green — deliberately, so
 * that "battery is green" holds everywhere — and the lines chart is the one place that draws battery
 * power and battery SoC at the same time. They sit on different axes (kW left, % right), so hue
 * would be a poor discriminator anyway; texture is the honest one.
 */
export const SOC_DASH = [4, 3];

/**
 * Overlaid-line (sidebar) datasets: solar/load/battery/grid as lines on the left axis (bars when
 * daily/energy mode), SoC as a line on the right axis, plus a padded min/max SoC band in energy
 * mode. Used by the lines chart. The caller computes `paddedSOCData` (energy mode only).
 */
export function buildLineDatasets(
  chartData: LineChartData,
  paddedSOCData: PaddedSOCData | null,
): any[] {
  if (chartData.mode === "energy") {
    // Energy mode: Use bar chart data structure
    return [
      {
        label: "Solar",
        data: chartData.solar, // Already in kWh for energy mode
        backgroundColor: CHART_COLORS.solar.primary,
        borderWidth: 0, // No border
        yAxisID: "y",
        barPercentage: 0.9,
        categoryPercentage: 0.8,
      },
      {
        label: "Load",
        data: chartData.load, // Already in kWh for energy mode
        backgroundColor: CHART_COLORS.load,
        borderWidth: 0, // No border
        yAxisID: "y",
        barPercentage: 0.9,
        categoryPercentage: 0.8,
      },
      // Add battery power if available (for energy mode, this would be battery energy)
      ...(chartData.batteryW != null
        ? [
            {
              label: "Battery",
              data: chartData.batteryW, // Already in kWh for energy mode
              backgroundColor: CHART_COLORS.battery.main,
              borderWidth: 0, // No border
              yAxisID: "y",
              barPercentage: 0.9,
              categoryPercentage: 0.8,
            },
          ]
        : []),
      // Add grid if available
      ...(chartData.grid != null
        ? [
            {
              label: "Grid",
              data: chartData.grid, // Already in kWh for energy mode
              backgroundColor: CHART_COLORS.grid.main,
              borderWidth: 0, // No border
              yAxisID: "y",
              barPercentage: 0.9,
              categoryPercentage: 0.8,
            },
          ]
        : []),
      // Add SOC range area if we have min/max data
      ...(paddedSOCData
        ? [
            {
              label: "Battery SOC Range",
              type: "line" as const,
              labels: paddedSOCData.timestamps,
              data: paddedSOCData.timestamps.map((t, i) => ({
                x: t,
                y: paddedSOCData.max[i],
              })), // Upper boundary with padding
              borderColor: "transparent",
              backgroundColor: "rgba(74, 222, 128, 0.3)", // green-400 with 30% opacity
              yAxisID: "y1",
              tension: 0.4, // Nice curved splines
              borderWidth: 0,
              pointRadius: 0, // No dots
              pointHoverRadius: 0, // No dots on hover
              pointHitRadius: 0, // No hit area for points
              fill: "+1", // Fill to next dataset (min line)
              showLine: true,
              clip: false, // Don't clip at chart edges
              order: 10, // Higher number = drawn first (behind everything)
            },
            {
              label: "", // No label for min line (hidden from legend)
              type: "line" as const,
              labels: paddedSOCData.timestamps,
              data: paddedSOCData.timestamps.map((t, i) => ({
                x: t,
                y: paddedSOCData.min[i],
              })), // Lower boundary with padding
              borderColor: "transparent",
              backgroundColor: "transparent",
              yAxisID: "y1",
              tension: 0.4, // Nice curved splines
              borderWidth: 0,
              pointRadius: 0, // No dots
              pointHoverRadius: 0, // No dots on hover
              pointHitRadius: 0, // No hit area for points
              fill: false,
              showLine: true,
              clip: false, // Don't clip at chart edges
              order: 10, // Higher number = drawn first (behind everything)
            },
          ]
        : []),
      {
        label: "Battery SoC",
        type: "line" as const, // Keep SoC as line even in bar chart
        data: chartData.batterySOC, // Already in percentage
        borderColor: CHART_COLORS.battery.soc,
        backgroundColor: CHART_COLORS.battery.soc,
        // Dashed, because `battery.soc` and `battery.main` are the SAME green and this chart draws
        // battery power and SoC together. Texture carries the distinction so "battery is green"
        // stays true. Keep in sync with the legend swatch in ChartTooltip.
        borderDash: SOC_DASH,
        yAxisID: "y1",
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
        order: -1, // Negative number = drawn last (on top of everything)
      },
    ];
  }

  // Power mode: Use line chart data structure
  return [
    {
      label: "Solar",
      data: chartData.solar, // Already converted to kW by convertToKw()
      borderColor: CHART_COLORS.solar.primary,
      backgroundColor: CHART_COLORS.solar.primary,
      yAxisID: "y",
      tension: 0.1,
      borderWidth: 2,
      pointRadius: 0,
      fill: false, // Don't fill under the line
    },
    {
      label: "Load",
      data: chartData.load, // Already converted to kW by convertToKw()
      borderColor: CHART_COLORS.load,
      backgroundColor: CHART_COLORS.load,
      yAxisID: "y",
      tension: 0.1,
      borderWidth: 2,
      pointRadius: 0,
      fill: false, // Don't fill under the line
    },
    // Add battery power if available
    ...(chartData.batteryW != null
      ? [
          {
            label: "Battery",
            data: chartData.batteryW, // Already converted to kW by convertToKw()
            borderColor: CHART_COLORS.battery.main,
            backgroundColor: CHART_COLORS.battery.main,
            yAxisID: "y",
            tension: 0.1,
            borderWidth: 2,
            pointRadius: 0,
            fill: false, // Don't fill under the line
          },
        ]
      : []),
    // Add grid if available
    ...(chartData.grid != null
      ? [
          {
            label: "Grid",
            data: chartData.grid, // Already converted to kW by convertToKw()
            borderColor: CHART_COLORS.grid.main,
            backgroundColor: CHART_COLORS.grid.main,
            yAxisID: "y",
            tension: 0.1,
            borderWidth: 2,
            pointRadius: 0,
            fill: false, // Don't fill under the line
          },
        ]
      : []),
    {
      label: "Battery SoC",
      data: chartData.batterySOC, // Already in percentage
      borderColor: CHART_COLORS.battery.soc,
      backgroundColor: CHART_COLORS.battery.soc,
      // Dashed — see the energy-mode SoC dataset above for why.
      borderDash: SOC_DASH,
      yAxisID: "y1",
      tension: 0.1,
      borderWidth: 2,
      pointRadius: 0,
      fill: false, // Don't fill under the line
    },
  ];
}

/**
 * Stacked-area (site) datasets: power/energy series stacked on the left axis (areas when 5m/30m,
 * bars when daily), with the SoC overlay on the right axis. Only series in `effectiveVisibleSeries`
 * are drawn. Used by the stacked chart.
 */

/**
 * Stacked-area (site) datasets: power/energy series stacked on the left axis (areas when 5m/30m,
 * bars when daily), with the SoC overlay on the right axis. Only series in `effectiveVisibleSeries`
 * are drawn. Used by the stacked chart.
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
    // Match the lines chart pattern: max dataset fills DOWN to min dataset

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
