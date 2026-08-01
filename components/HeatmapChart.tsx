"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { classifyUnit } from "@/lib/point/unit-typography";
import { useQuery } from "@tanstack/react-query";
import { HttpError } from "@/lib/queries";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  ChartOptions,
} from "chart.js";
import { Chart } from "react-chartjs-2";
import { MatrixController, MatrixElement } from "chartjs-chart-matrix";
import { format } from "date-fns";
import {
  now,
  toCalendarDate,
  type ZonedDateTime,
} from "@internationalized/date";
import { encodeI18nToUrlSafeString } from "@/lib/url-date";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/heatmap-colors";
import {
  bucketHeatmap,
  daysOffFrame,
  formatUtcOffset,
} from "@/lib/heatmap-buckets";
import {
  BLACK_SENTINEL,
  POWER_BASELINE_W,
  isBaselinePower,
  normalizeHeatmapValue,
} from "@/lib/heatmap-scale";
import ServerErrorModal from "./ServerErrorModal";
import { formatTime, formatDate } from "@/lib/fe-date-format";
import { PointInfo } from "@/lib/point/point-info";

/**
 * Renders this chart's y-axis labels with a mixed weight (bold month, normal day).
 *
 * 🛑 **Must stay a per-instance plugin — never `ChartJS.register(...)`.** A globally-registered
 * plugin runs on EVERY Chart.js instance in the process, and this one has no chart-type guard, so
 * registering it globally made it re-draw the y-tick labels of the dashboard's lines and stacked
 * charts on top of the ones Chart.js had already drawn (right-aligned at `chartArea.left - 10`,
 * against Chart.js's own padding) — doubled, ghosted axis labels. That was live in production,
 * because `components/dashboard/registry.tsx` statically imports every card plugin, so merely
 * loading this module contaminated every dashboard page whether or not a heatmap was on it.
 * It is passed via the `plugins` prop on the `<Chart>` below instead. See
 * `docs/plans/chart-library-consolidation.md` defect #7.
 */
const customYAxisPlugin = {
  id: "customYAxisLabels",
  afterDraw: (chart: any) => {
    const ctx = chart.ctx;
    const yAxis = chart.scales.y;

    if (!yAxis) return;

    ctx.save();
    ctx.textBaseline = "middle";

    yAxis.ticks.forEach((tick: any, index: number) => {
      const y = yAxis.getPixelForTick(index);
      const label = tick.label;

      if (!label) return;

      // Convert label to string (it might be a number or array)
      const labelStr = String(label);

      // Check if this label has a month prefix (word word ...)
      const monthMatch = labelStr.match(/^([A-Za-z]+)\s+([A-Za-z]+\s+.+)$/);

      if (monthMatch) {
        // Label has month prefix - render month in white/bold, rest in gray/normal
        const monthPart = monthMatch[1];
        const dayPart = monthMatch[2];

        // Measure text widths for proper positioning
        ctx.font = "10px DM Sans, system-ui, sans-serif";
        const normalDayWidth = ctx.measureText(dayPart).width;
        const spaceWidth = ctx.measureText(" ").width;

        ctx.font = "bold 10px DM Sans, system-ui, sans-serif";
        const boldMonthWidth = ctx.measureText(monthPart).width;

        // Calculate starting x position (right-aligned, using chart area left edge)
        const totalWidth = boldMonthWidth + spaceWidth + normalDayWidth;
        const chartAreaLeft = chart.chartArea.left;
        const startX = chartAreaLeft - totalWidth - 10;

        // Draw month in white/bold
        ctx.font = "bold 10px DM Sans, system-ui, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(monthPart, startX, y);

        // Draw space and day in gray/normal (same as regular labels)
        ctx.font = "10px DM Sans, system-ui, sans-serif";
        ctx.fillStyle = "#9ca3af";
        ctx.fillText(" " + dayPart, startX + boldMonthWidth, y);
      } else {
        // Regular label - render in gray, right-aligned
        ctx.font = "10px DM Sans, system-ui, sans-serif";
        ctx.fillStyle = "#9ca3af";
        ctx.textAlign = "right";
        const chartAreaLeft = chart.chartArea.left;
        ctx.fillText(labelStr, chartAreaLeft - 10, y);
        ctx.textAlign = "left"; // Reset
      }
    });

    ctx.restore();
  },
};

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  MatrixController,
  MatrixElement,
);

interface HeatmapChartProps {
  systemId: number;
  pointPath: string;
  pointUnit: string;
  metricType: string;
  /** IANA display zone — used ONLY to work out which days were on a different real offset. */
  timezone: string;
  /**
   * `areas.day_offset_min` — the fixed offset every day is bucketed and labelled in. NOT the tz
   * offset (they diverge after a re-bucket) and NOT the IANA zone (which observes DST, which is what
   * used to lose an hour of data twice a year). See lib/heatmap-buckets.ts.
   */
  dayOffsetMin: number;
  palette: HeatmapPaletteKey;
  className?: string;
  onFetchInfo?: (info: {
    interval: string;
    duration: string;
    startTime: ZonedDateTime | null;
    endTime: ZonedDateTime | null;
  }) => void;
}

interface HeatmapDataPoint {
  x: string; // Time of day (HH:mm)
  y: string; // Date (yyyy-MM-dd)
  v: number | null; // Value
}

interface HeatmapData {
  data: HeatmapDataPoint[];
  min: number;
  max: number;
  xLabels: string[]; // Time labels
  yLabels: string[]; // Date labels
  /** Date keys whose real UTC offset differed from the labelling frame (DST). Asterisked in the axis. */
  offFrameDays: Set<string>;
}

/** Raw fetch result carried in the React Query cache; transformed into `HeatmapData`
 *  in a `useMemo` so the derived arrays stay referentially stable across refetches. */
interface HeatmapFetchResult {
  result: any;
  fetchStartTime: ZonedDateTime;
  fetchEndTime: ZonedDateTime;
}

/** Thrown when the API replies with an HTML page (e.g. an expired session), so the
 *  caller can surface the "connection" modal instead of a generic server error. */
class HeatmapHtmlError extends Error {
  constructor() {
    super("Session may have expired. Please refresh the page.");
    this.name = "HeatmapHtmlError";
  }
}

export default function HeatmapChart({
  systemId,
  pointPath,
  pointUnit,
  metricType,
  timezone,
  dayOffsetMin,
  palette,
  className = "",
  onFetchInfo,
}: HeatmapChartProps) {
  const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);
  const [errorType, setErrorType] = useState<"connection" | "server" | null>(
    null,
  );
  const [errorDetails, setErrorDetails] = useState<string | undefined>(
    undefined,
  );
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const isBaselinePowerSeries = isBaselinePower(pointPath);

  // Fetch 30 days of half-hourly data for the selected point. The query carries the raw
  // payload + the computed range; the heatmap grid is derived in a useMemo below so the
  // arrays stay referentially stable across refetches.
  const {
    data: fetchResult,
    isPending,
    isError,
    error: queryError,
  } = useQuery<HeatmapFetchResult>({
    queryKey: ["system", systemId, "heatmap", pointPath, timezone],
    queryFn: async () => {
      // Hide tooltip when starting to load new data
      const tooltipEl = document.getElementById("chartjs-tooltip");
      if (tooltipEl) {
        tooltipEl.style.opacity = "0";
      }

      // Calculate date range using @internationalized/date
      // End: midnight tomorrow (00:00 tomorrow in AEST)
      const nowAEST = now(timezone);
      const tomorrowDate = toCalendarDate(nowAEST).add({ days: 1 });
      const fetchEndTime = nowAEST.set({
        year: tomorrowDate.year,
        month: tomorrowDate.month,
        day: tomorrowDate.day,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      });

      // Start: 30 days before end, plus 30 minutes
      const fetchStartTime = fetchEndTime
        .subtract({ days: 30 })
        .add({ minutes: 30 });

      // Encode times as URL-safe strings (with embedded timezone)
      const startTimeEncoded = encodeI18nToUrlSafeString(fetchStartTime, true);
      const endTimeEncoded = encodeI18nToUrlSafeString(fetchEndTime, true);

      // Fetch 30 days of data at 30-minute intervals
      // Use preferred aggregation based on metric type (energy: delta, soc: last, others: avg)
      const seriesSuffix =
        PointInfo.getPreferredAggregationForMetricType(metricType);
      const url = `/api/history?interval=30m&startTime=${startTimeEncoded}&endTime=${endTimeEncoded}&systemId=${systemId}&series=${pointPath}.${seriesSuffix}`;
      const response = await fetch(url, {
        credentials: "same-origin",
      });

      if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          throw new HeatmapHtmlError();
        }
        throw new HttpError(response.status, response.statusText);
      }

      const result = await response.json();
      return { result, fetchStartTime, fetchEndTime };
    },
    staleTime: 60_000,
    enabled: !!systemId,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Send fetch info to parent whenever a new range is fetched.
  useEffect(() => {
    if (fetchResult && onFetchInfo) {
      onFetchInfo({
        interval: "30m",
        duration: "30d",
        startTime: fetchResult.fetchStartTime,
        endTime: fetchResult.fetchEndTime,
      });
    }
    // onFetchInfo is a stable setter from the parent; depend on the fetched range only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchResult]);

  // Transform the raw payload into the heatmap grid. Returns null if the series/history
  // is missing (surfaced as a "No data found for this point" error below).
  const heatmapData = useMemo<HeatmapData | null>(() => {
    if (!fetchResult) return null;
    const { result } = fetchResult;

    // Find the series for the requested point.
    // Use .delta for energy metrics, .avg for others (same as request).
    const seriesSuffix =
      PointInfo.getPreferredAggregationForMetricType(metricType);
    const expectedSeriesPath = `${pointPath}.${seriesSuffix}`;
    const series = result.data?.find((s: any) => {
      const seriesPath = s.path || s.id?.split(".").slice(2).join(".");
      return seriesPath === expectedSeriesPath;
    });

    if (!series || !series.history) {
      console.error("[HeatmapChart] No series/history for", expectedSeriesPath);
      return null;
    }

    const { firstInterval, interval, data } = series.history;
    const intervalMs = parseInterval(interval);
    if (intervalMs === null || intervalMs <= 0) {
      console.error(
        "[HeatmapChart] Unrecognised interval from /api/history:",
        interval,
      );
      return null; // surfaces as the "No data found for this point" error path
    }

    // Bucket by the FIXED day offset, never the DST-aware zone — see lib/heatmap-buckets.ts for
    // why (a 46/50-slot local day used to lose an hour or fabricate a gap). Unit-tested there
    // against both real Melbourne transitions.
    const bucketed = bucketHeatmap(data as (number | null)[], {
      firstIntervalEndMs: new Date(firstInterval).getTime(),
      intervalMs,
      dayOffsetMin,
    });

    return {
      data: bucketed.cells,
      min: bucketed.min,
      max: bucketed.max,
      xLabels: bucketed.timeLabels,
      yLabels: bucketed.dayKeys,
      // Rows the axis frame does not describe: the site was on a different real offset that day, so
      // its columns read an hour out. Marked with an asterisk + footnote rather than silently shown.
      offFrameDays: daysOffFrame(bucketed.dayKeys, timezone, dayOffsetMin),
    };
  }, [fetchResult, pointPath, metricType, timezone, dayOffsetMin]);

  // Initial-load spinner vs. refetch overlay (preserves the original `loading` gate).
  // A successful fetch whose series is missing is an error state, not still-loading.
  const loading = isPending;

  // Derived error string for the inline error UI.
  const error =
    isError && !(queryError instanceof HeatmapHtmlError)
      ? queryError instanceof Error
        ? queryError.message
        : "Unknown error"
      : fetchResult && !heatmapData
        ? "No data found for this point"
        : null;

  // Map query/transform failures onto the error modal (connection vs. server),
  // matching the original try/catch behaviour.
  useEffect(() => {
    if (isError) {
      if (queryError instanceof HeatmapHtmlError) {
        setIsErrorModalOpen(true);
        setErrorType("connection");
        setErrorDetails(queryError.message);
      } else {
        console.error("Error fetching heatmap data:", queryError);
        const msg =
          queryError instanceof Error ? queryError.message : "Unknown error";
        setIsErrorModalOpen(true);
        setErrorType("server");
        setErrorDetails(msg);
      }
    } else if (fetchResult && !heatmapData) {
      // Fetched OK but the requested series/history was absent.
      const msg = "No data found for this point";
      console.error("Error fetching heatmap data:", msg);
      setIsErrorModalOpen(true);
      setErrorType("server");
      setErrorDetails(msg);
    }
  }, [isError, queryError, fetchResult, heatmapData]);

  // Cleanup tooltip on unmount
  useEffect(() => {
    return () => {
      const tooltipEl = document.getElementById("chartjs-tooltip");
      if (tooltipEl) {
        tooltipEl.remove();
      }
    };
  }, []);

  /**
   * Parse an interval string ("30m") to milliseconds, or `null` if it is not one.
   *
   * Returning `null` rather than `0` matters: with `intervalMs = 0` every reading mapped to the same
   * instant, so the entire heatmap silently collapsed into a single column and looked like a data
   * problem rather than a parsing one. The caller turns `null` into the ordinary "no data" error
   * path, which is visible.
   */
  function parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
  }

  // Palette position for a raw value — see lib/heatmap-scale.ts (unit-tested there).
  const getNormalizedValue = (
    value: number,
    min: number,
    max: number,
  ): number =>
    normalizeHeatmapValue(value, min, max, {
      baselinePower: isBaselinePowerSeries,
    });

  // Get color for a normalized value (0-1)
  const getColor = (normalizedValue: number): string => {
    if (normalizedValue === BLACK_SENTINEL) {
      return "#111827"; // gray-900 (dashboard background) for load/source power at or below standby
    }
    const paletteConfig = HEATMAP_PALETTES[palette];
    return paletteConfig.fn(normalizedValue);
  };

  // Add mousemove listener to hide tooltip when mouse leaves chart area
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    const handleMouseMove = (e: MouseEvent) => {
      const canvas = container.querySelector("canvas");
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Get the chart instance to access chartArea
      const chartInstance = ChartJS.getChart(canvas);
      if (!chartInstance?.chartArea) return;

      const chartArea = chartInstance.chartArea;

      // Check if mouse is outside the chart data area
      const isOutside =
        x < chartArea.left ||
        x > chartArea.right ||
        y < chartArea.top ||
        y > chartArea.bottom;

      if (isOutside) {
        // Hide tooltip
        const tooltipEl = document.getElementById("chartjs-tooltip");
        if (tooltipEl) {
          tooltipEl.style.opacity = "0";
        }
      }
    };

    container.addEventListener("mousemove", handleMouseMove);
    return () => {
      container.removeEventListener("mousemove", handleMouseMove);
    };
  }, [heatmapData]); // Re-run when chart data changes

  // Chart configuration
  const chartOptions: ChartOptions<"matrix"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "point",
      intersect: true,
    },
    layout: {
      padding: {
        left: 10, // Minimal space for y-axis labels
      },
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        enabled: false, // Disable default tooltip, we'll use external
        external: (context) => {
          // Get or create tooltip element
          let tooltipEl = document.getElementById("chartjs-tooltip");

          if (!tooltipEl) {
            tooltipEl = document.createElement("div");
            tooltipEl.id = "chartjs-tooltip";
            tooltipEl.style.position = "absolute";
            tooltipEl.style.zIndex = "9999";
            tooltipEl.style.pointerEvents = "none";
            tooltipEl.style.transition = "all 0.1s ease";
            document.body.appendChild(tooltipEl);
          }

          // Hide if no tooltip
          const tooltipModel = context.tooltip;
          if (tooltipModel.opacity === 0) {
            tooltipEl.style.opacity = "0";
            return;
          }

          // Check if pointer is within the chart data area (not over labels/axes)
          const chartArea = context.chart.chartArea;
          const isInChartArea =
            tooltipModel.caretX >= chartArea.left &&
            tooltipModel.caretX <= chartArea.right &&
            tooltipModel.caretY >= chartArea.top &&
            tooltipModel.caretY <= chartArea.bottom;

          if (!isInChartArea) {
            tooltipEl.style.opacity = "0";
            return;
          }

          // Set tooltip content
          if (tooltipModel.body) {
            const dataPoint = tooltipModel.dataPoints[0]
              .raw as HeatmapDataPoint;

            // Parse date and time from dataPoint (y is YYYY-MM-DD, x is HH:mm)
            const dateTimeStr = `${dataPoint.y}T${dataPoint.x}:00`;
            const dateTime = new Date(dateTimeStr);

            // Format using standardized formatting functions
            const timeStr = formatTime(dateTime, false); // e.g., "6:30 am"
            const dateStr = formatDate(dateTime); // e.g., "24 Oct 2025"

            // Calculate cell color (same logic as chart backgroundColor)
            let cellColor: string;
            if (dataPoint.v === null || dataPoint.v === undefined) {
              cellColor = "rgba(55, 65, 81, 0.3)"; // gray-700 for null values
            } else {
              const normalized = getNormalizedValue(
                dataPoint.v,
                heatmapData?.min ?? 0,
                heatmapData?.max ?? 1,
              );
              cellColor = getColor(normalized);
            }

            // Format value and unit based on metric type
            let displayValue: string;
            let displayUnit: string;
            if (dataPoint.v === null) {
              displayValue = "No data";
              displayUnit = "";
            } else if (metricType === "energy") {
              // Energy: convert Wh to kWh
              displayValue = (dataPoint.v / 1000).toFixed(1);
              displayUnit = pointUnit.replace("Wh", "kWh");
            } else if (metricType === "power") {
              // Power: convert W to kW
              displayValue = (dataPoint.v / 1000).toFixed(1);
              displayUnit = "kW";
            } else {
              // Other metrics (rate, time, etc.): use value and unit as-is
              displayValue = dataPoint.v.toFixed(2);
              displayUnit = pointUnit;
            }
            // Tight for %/°C/¢, hair-spaced for kW/kWh/… — same rule as <Value>, so the tooltip
            // agrees with the tiles instead of reading "3.4kW". See number-typography.md.
            const bodyText =
              displayValue === "No data"
                ? displayValue
                : `${displayValue}${
                    classifyUnit(displayUnit).headGap === "hair" ? " " : ""
                  }${displayUnit}`;

            tooltipEl.innerHTML = `
              <div style="
                background: rgb(17, 24, 39);
                border: 1px solid rgb(75, 85, 99);
                border-radius: 6px;
                padding: 12px;
                color: white;
                font-size: 12px;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
              ">
                <div style="font-weight: bold; margin-bottom: 4px;">${timeStr}, ${dateStr}</div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <div style="
                    width: 12px;
                    height: 12px;
                    background: ${cellColor};
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 2px;
                    flex-shrink: 0;
                  "></div>
                  <div>${bodyText}</div>
                </div>
              </div>
            `;
          }

          // Position tooltip
          const canvas = context.chart.canvas;
          const rect = canvas.getBoundingClientRect();

          // Calculate base position
          const baseX = rect.left + window.scrollX + tooltipModel.caretX;
          const baseY = rect.top + window.scrollY + tooltipModel.caretY;

          // Get tooltip dimensions (need to make visible first to measure)
          tooltipEl.style.opacity = "1";
          const tooltipRect = tooltipEl.getBoundingClientRect();
          const tooltipWidth = tooltipRect.width;
          const tooltipHeight = tooltipRect.height;

          // Check if tooltip would overflow chart boundaries
          const offset = 10; // Offset from pointer
          const chartRight = rect.right + window.scrollX;
          const chartBottom = rect.bottom + window.scrollY;

          const wouldOverflowRight = baseX + tooltipWidth + offset > chartRight;
          const wouldOverflowBottom =
            baseY + tooltipHeight + offset > chartBottom;

          // Position horizontally
          if (wouldOverflowRight) {
            // Position to the left of pointer
            tooltipEl.style.left = baseX - tooltipWidth - offset + "px";
          } else {
            // Position to the right of pointer
            tooltipEl.style.left = baseX + offset + "px";
          }

          // Position vertically
          if (wouldOverflowBottom) {
            // Position above pointer
            tooltipEl.style.top = baseY - tooltipHeight - offset + "px";
          } else {
            // Position below pointer
            tooltipEl.style.top = baseY + offset + "px";
          }
        },
      },
    },
    scales: {
      x: {
        type: "category",
        labels: heatmapData?.xLabels || [],
        offset: true,
        ticks: {
          color: "#9ca3af", // gray-400
          font: {
            size: 10,
            family: "DM Sans, system-ui, sans-serif",
          },
          maxRotation: 90,
          minRotation: 90,
          callback: function (_value: any, index: any) {
            // Show every 4th label (every 2 hours)
            if (index % 4 === 0) {
              return heatmapData?.xLabels[index];
            }
            return "";
          },
        },
        grid: {
          display: false,
        },
      },
      y: {
        type: "category",
        labels: heatmapData?.yLabels || [],
        offset: true,
        ticks: {
          display: true, // Keep visible but use custom rendering
          color: "transparent", // Make default labels invisible
          padding: 5,
          callback: function (_value: any, index: any) {
            const date = heatmapData?.yLabels[index];
            if (!date) return "";

            // The asterisk means "this day was on a different UTC offset than the columns are
            // labelled in" — i.e. DST. Explained in the footnote under the chart.
            const mark = heatmapData?.offFrameDays.has(date) ? "*" : "";
            const localDate = new Date(date + "T00:00:00");
            // Dates are sorted most recent first, so last index is the oldest (first chronologically)
            const isFirstChronologically =
              index === (heatmapData?.yLabels.length ?? 0) - 1;
            const isFirstOfMonth = localDate.getDate() === 1;

            // Show month for first chronological date or first of month
            if (isFirstChronologically || isFirstOfMonth) {
              return format(localDate, "MMM EEE d") + mark;
            }

            // Regular format
            return format(localDate, "EEE d") + mark;
          },
        },
        grid: {
          display: false,
        },
      },
    },
  };

  const chartData = {
    datasets: [
      {
        data: heatmapData?.data || [],
        backgroundColor: (context: any) => {
          const value = context.dataset.data[context.dataIndex]?.v;
          if (value === null || value === undefined) {
            return "rgba(55, 65, 81, 0.3)"; // gray-700 for null values
          }

          const normalized = getNormalizedValue(
            value,
            heatmapData?.min ?? 0,
            heatmapData?.max ?? 1,
          );
          return getColor(normalized);
        },
        borderColor: "rgba(0, 0, 0, 0.1)",
        borderWidth: 1,
        width: ({ chart }: any) => {
          const area = chart.chartArea;
          if (!area || !heatmapData) return 10;
          return (area.width / heatmapData.xLabels.length) * 0.95;
        },
        height: ({ chart }: any) => {
          const area = chart.chartArea;
          if (!area || !heatmapData) return 10;
          return (area.height / heatmapData.yLabels.length) * 0.95;
        },
      },
    ],
  };

  // Only show spinner for initial load (no data yet)
  if (loading && !heatmapData) {
    return (
      <div className={className}>
        <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
          <div
            className="flex items-center justify-center"
            style={{ height: "600px" }}
          >
            <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        </div>
      </div>
    );
  }

  if (isErrorModalOpen && errorType) {
    return (
      <ServerErrorModal
        isOpen={isErrorModalOpen}
        errorType={errorType}
        errorDetails={errorDetails}
        onClose={() => {
          setIsErrorModalOpen(false);
          setErrorType(null);
          setErrorDetails(undefined);
        }}
      />
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }

  if (!heatmapData) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-gray-400">No data available</div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="bg-gray-900 p-4 rounded-lg border border-gray-700">
        <div className="relative">
          <div ref={chartContainerRef} style={{ height: "600px" }}>
            <Chart
              type="matrix"
              data={chartData}
              options={chartOptions}
              // Per-instance, NOT ChartJS.register — see the plugin's own comment.
              plugins={[customYAxisPlugin as never]}
            />
          </div>

          {/* Loading overlay - dims chart and shows spinner while loading new data */}
          {loading && (
            <div className="absolute inset-0 bg-gray-900/80 flex items-center justify-center rounded">
              <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
        </div>

        {/* Color legend */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="text-xs text-gray-400">
            {metricType === "energy" || metricType === "power"
              ? (heatmapData.min / 1000).toFixed(1)
              : heatmapData.min.toFixed(2)}
            {metricType === "energy"
              ? pointUnit.replace("Wh", "kWh")
              : metricType === "power"
                ? "kW"
                : pointUnit}
          </span>
          <div
            className="h-4 rounded"
            style={{
              width: "200px",
              background: (() => {
                // Special gradient for load and source power: gray-900 baseline (0-50W) then color gradient
                if (isBaselinePowerSeries) {
                  const baselineThreshold = POWER_BASELINE_W;
                  const range = heatmapData.max - heatmapData.min;
                  const baselinePercentage = Math.min(
                    ((baselineThreshold - heatmapData.min) / range) * 100,
                    100,
                  );

                  if (baselinePercentage >= 100) {
                    // All values are below threshold
                    return "#111827";
                  } else if (baselinePercentage <= 0) {
                    // All values are above threshold, use normal gradient
                    return `linear-gradient(to right, ${getColor(0)}, ${getColor(0.25)}, ${getColor(0.5)}, ${getColor(0.75)}, ${getColor(1)})`;
                  } else {
                    // Mixed: gray-900 for 0-50W portion, then color gradient
                    return `linear-gradient(to right, #111827 0%, #111827 ${baselinePercentage}%, ${getColor(0)} ${baselinePercentage}%, ${getColor(0.25)} ${baselinePercentage + (100 - baselinePercentage) * 0.25}%, ${getColor(0.5)} ${baselinePercentage + (100 - baselinePercentage) * 0.5}%, ${getColor(0.75)} ${baselinePercentage + (100 - baselinePercentage) * 0.75}%, ${getColor(1)} 100%)`;
                  }
                }
                // Standard gradient for other metrics
                return `linear-gradient(to right, ${getColor(0)}, ${getColor(0.25)}, ${getColor(0.5)}, ${getColor(0.75)}, ${getColor(1)})`;
              })(),
            }}
          />
          <span className="text-xs text-gray-400">
            {metricType === "energy" || metricType === "power"
              ? (heatmapData.max / 1000).toFixed(1)
              : heatmapData.max.toFixed(2)}
            {metricType === "energy"
              ? pointUnit.replace("Wh", "kWh")
              : metricType === "power"
                ? "kW"
                : pointUnit}
          </span>
        </div>

        {/* Only shown when some row actually is off-frame, so it never becomes background noise. */}
        {heatmapData.offFrameDays.size > 0 && (
          <p className="mt-2 text-center text-[11px] text-gray-500">
            Times are {formatUtcOffset(dayOffsetMin)} for every day, so a
            routine lines up across the whole chart.{" "}
            <span className="text-gray-400">*</span> marks days the site was on
            a different offset (daylight saving) — the local clock read an hour
            later than the column says.
          </p>
        )}
      </div>
    </div>
  );
}
