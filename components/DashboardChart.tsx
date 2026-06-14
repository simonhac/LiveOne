"use client";

import { type ChartOptions } from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import "chartjs-adapter-date-fns";
import {
  registerChartScaffold,
  buildShadingAnnotations,
  buildTimeScale,
  type ChartTimeRange,
} from "@/lib/charts/scaffold";
import {
  buildLineDatasets,
  buildStackedAreaDatasets,
} from "@/lib/charts/datasets";
import type {
  ChartData,
  LineChartData,
  PaddedSOCData,
} from "@/lib/charts/types";

registerChartScaffold();

/**
 * The presentational dashboard chart (chart-generalization phase 2c). One component, two visual
 * variants — `lines` (overlaid lines / energy bars, the sidebar chart) and `stacked-areas` (the site
 * load/generation chart). It owns the Chart.js options + dataset assembly + render; data ownership
 * and interaction state stay in the chart cards (LinesChartCard / SiteChartsCard) and, later, the
 * descriptor-driven `chart` card. The options/dataset logic is moved verbatim from those components
 * — no behaviour change.
 */

type CommonProps = {
  timeRange: ChartTimeRange;
  now: Date;
  windowStart: Date;
  onHover: (event: any, activeElements: any[], chart: any) => void;
  chartRef: React.MutableRefObject<any>;
  /** className for the chart-area wrapper div. */
  className?: string;
  onMouseLeave?: () => void;
};

type LinesProps = CommonProps & {
  variant: "lines";
  chartData: LineChartData;
  paddedSOCData: PaddedSOCData | null;
  maxPowerHint?: number;
};

type StackedProps = CommonProps & {
  variant: "stacked-areas";
  chartData: ChartData;
  effectiveVisibleSeries: Set<string>;
  mode: "load" | "generation";
  hoveredTimestamp: Date | null;
};

export type DashboardChartProps = LinesProps | StackedProps;

const FONT = { size: 10, family: "DM Sans, system-ui, sans-serif" };

/** Overlaid-line / energy-bar options (the lines chart). */
function buildLineChartOptions(p: LinesProps): ChartOptions<any> {
  const { timeRange, now, windowStart, onHover, chartData, maxPowerHint } = p;
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
    onHover,
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
      annotation: {
        annotations: buildShadingAnnotations(timeRange, now, windowStart),
      },
    },
    scales: {
      x: buildTimeScale(timeRange, now, windowStart),
      y: {
        type: "linear" as const,
        display: true,
        position: "left" as const,
        title: { display: false },
        // Use maxPowerHint for power mode, auto-scale for energy mode
        suggestedMax: chartData.mode === "energy" ? undefined : maxPowerHint,
        grid: {
          color: "rgb(55, 65, 81)", // gray-700
          display: true,
          drawOnChartArea: true,
        },
        ticks: {
          color: "rgb(156, 163, 175)", // gray-400
          font: FONT,
          callback: function (value: any, index: any, ticks: any) {
            // Add unit only to the last (top) tick; kWh for energy, kW for power
            if (index === ticks.length - 1) {
              const unit = chartData.mode === "energy" ? "kWh" : "kW";
              return value + " " + unit;
            }
            return value;
          },
        },
      },
      y1: {
        type: "linear" as const,
        display: true,
        position: "right" as const,
        title: { display: false },
        grid: {
          display: true,
          drawOnChartArea: false, // avoid overlapping the left-axis grid
        },
        ticks: {
          color: "rgb(156, 163, 175)", // gray-400
          font: FONT,
          callback: function (value: any, index: any, ticks: any) {
            if (index === ticks.length - 1) {
              return value + "%";
            }
            return value;
          },
        },
        min: 0,
        max: 100,
      },
    },
  };
}

/** Stacked-area / bar options (the stacked chart). */
function buildStackedChartOptions(p: StackedProps): ChartOptions<any> {
  const {
    timeRange,
    now,
    windowStart,
    onHover,
    chartData,
    mode,
    hoveredTimestamp,
  } = p;
  const isBarChart = chartData.mode === "energy";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false, // Disable all animations
    hover: {
      animationDuration: 0, // No animation on hover
    },
    interaction: {
      mode: "index" as const,
      intersect: false,
      axis: "x" as const, // Only consider x-axis for hover (more stable)
    },
    onHover,
    // Bar chart specific configuration
    ...(isBarChart && {
      barPercentage: 0.95,
      categoryPercentage: 0.95,
    }),
    plugins: {
      legend: { display: false }, // Legend now shown in the table
      tooltip: { enabled: false },
      annotation: {
        animation: false, // Disable animation for immediate updates
        annotations: [
          ...buildShadingAnnotations(timeRange, now, windowStart),
          // Add vertical line for hover position
          ...(hoveredTimestamp
            ? [
                {
                  type: "line",
                  scaleID: "x",
                  value: hoveredTimestamp.getTime(),
                  borderColor: "rgb(239, 68, 68)", // Red color
                  borderWidth: 1,
                  borderDash: [], // Solid line
                },
              ]
            : []),
        ],
      },
    },
    scales: {
      x: buildTimeScale(timeRange, now, windowStart),
      y: {
        type: "linear" as const,
        display: true,
        position: "left" as const,
        stacked: true,
        title: { display: false },
        min: 0,
        grid: {
          color: "rgb(55, 65, 81)",
          display: true,
          drawOnChartArea: true,
        },
        ticks: {
          color: "rgb(156, 163, 175)",
          font: FONT,
          callback: function (value: any, index: any, ticks: any) {
            if (index === ticks.length - 1) {
              return value + " kW";
            }
            return value;
          },
        },
      },
      y1: {
        type: "linear" as const,
        display: true,
        position: "right" as const,
        min: 0,
        max: 100,
        grid: {
          display: false, // Don't show grid for secondary axis
        },
        ticks: {
          color: mode === "generation" ? "rgb(156, 163, 175)" : "transparent", // Transparent for load chart
          font: FONT,
          callback: function (value: any) {
            return value + "%";
          },
        },
      },
    },
  };
}

export default function DashboardChart(props: DashboardChartProps) {
  const { chartData, chartRef, className, onMouseLeave } = props;
  const isBarChart = chartData.mode === "energy";

  const datasets =
    props.variant === "lines"
      ? buildLineDatasets(props.chartData, props.paddedSOCData)
      : buildStackedAreaDatasets(
          props.chartData,
          props.effectiveVisibleSeries,
          isBarChart,
        );

  const data: any = { labels: chartData.timestamps, datasets };
  const options =
    props.variant === "lines"
      ? buildLineChartOptions(props)
      : buildStackedChartOptions(props);

  return (
    <div className={className} onMouseLeave={onMouseLeave}>
      {isBarChart ? (
        <Bar ref={chartRef} data={data} options={options} />
      ) : (
        <Line ref={chartRef} data={data} options={options} />
      )}
    </div>
  );
}
