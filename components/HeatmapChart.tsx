"use client";

import { useEffect, useState, useRef } from "react";
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
  fromDate,
  now,
  toCalendarDate,
  type ZonedDateTime,
} from "@internationalized/date";
import { encodeI18nToUrlSafeString } from "@/lib/url-date";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/chart-colors";
import ServerErrorModal from "./ServerErrorModal";
import { formatTimeAEST } from "@/lib/date-utils";
import { formatTime, formatDate } from "@/lib/fe-date-format";

// Custom plugin to render y-axis labels with mixed colors
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

      // Check if this label has a month prefix (starts with a 3-letter month)
      const monthMatch = label.match(/^([A-Z][a-z]{2})\s+(.+)$/);

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
        ctx.fillText(label, chartAreaLeft - 10, y);
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

// Register custom plugin
ChartJS.register(customYAxisPlugin as any);

interface HeatmapChartProps {
  systemId: number;
  pointPath: string;
  pointUnit: string;
  timezone: string;
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
}

export default function HeatmapChart({
  systemId,
  pointPath,
  pointUnit,
  timezone,
  palette,
  className = "",
  onFetchInfo,
}: HeatmapChartProps) {
  const [heatmapData, setHeatmapData] = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);
  const [errorType, setErrorType] = useState<"connection" | "server" | null>(
    null,
  );
  const [errorDetails, setErrorDetails] = useState<string | undefined>(
    undefined,
  );
  const chartContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
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
        const startTimeEncoded = encodeI18nToUrlSafeString(
          fetchStartTime,
          true,
        );
        const endTimeEncoded = encodeI18nToUrlSafeString(fetchEndTime, true);

        // Fetch 30 days of data at 30-minute intervals
        const url = `/api/history?interval=30m&startTime=${startTimeEncoded}&endTime=${endTimeEncoded}&systemId=${systemId}&series=${pointPath}.avg`;
        console.log("[HeatmapChart] Fetching:", url);
        console.log(
          "[HeatmapChart] Calculated range - Start:",
          formatTimeAEST(fetchStartTime),
          "End:",
          formatTimeAEST(fetchEndTime),
        );

        const response = await fetch(url, {
          credentials: "same-origin",
        });

        if (!response.ok) {
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("text/html")) {
            setIsErrorModalOpen(true);
            setErrorType("connection");
            setErrorDetails(
              "Session may have expired. Please refresh the page.",
            );
            setLoading(false);
            return;
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log("[HeatmapChart] Response:", result);
        console.log("[HeatmapChart] result.data:", result.data);

        // Find the series for the requested point
        const series = result.data?.find((s: any) => {
          const seriesPath = s.path || s.id?.split(".").slice(2).join(".");
          console.log(
            "[HeatmapChart] Checking series:",
            s.id,
            "path:",
            seriesPath,
            "looking for:",
            `${pointPath}.avg`,
          );
          return seriesPath === `${pointPath}.avg`;
        });
        console.log("[HeatmapChart] Found series:", series);

        if (!series || !series.history) {
          console.error(
            "[HeatmapChart] No series or history found. series:",
            series,
          );
          throw new Error("No data found for this point");
        }

        // Process the data
        const { firstInterval, interval, data } = series.history;
        const startTime = new Date(firstInterval).getTime();
        const intervalMs = parseInterval(interval);

        // Send fetch info to parent (using the calculated times from above)
        if (onFetchInfo) {
          onFetchInfo({
            interval: "30m",
            duration: "30d",
            startTime: fetchStartTime,
            endTime: fetchEndTime,
          });
        }

        // Generate time labels (48 half-hour slots: 00:00, 00:30, ..., 23:30)
        const timeLabels: string[] = [];
        for (let h = 0; h < 24; h++) {
          timeLabels.push(`${String(h).padStart(2, "0")}:00`);
          timeLabels.push(`${String(h).padStart(2, "0")}:30`);
        }

        // Group data by date and time
        const dataByDate = new Map<string, Map<string, number | null>>();
        const dates = new Set<string>();

        data.forEach((value: number | null, index: number) => {
          // startTime is the end of the first interval
          const intervalEndTimestamp = startTime + index * intervalMs;
          const intervalStartTimestamp = intervalEndTimestamp - intervalMs;

          // Use interval START time for the time slot (e.g., 00:00 for the 00:00-00:30 interval)
          const jsDateForTime = new Date(intervalStartTimestamp);
          const zonedDateForTime = fromDate(jsDateForTime, timezone);
          const timeKey = `${String(zonedDateForTime.hour).padStart(2, "0")}:${String(zonedDateForTime.minute).padStart(2, "0")}`;

          // Use interval START time for the date (consistent with time key)
          const jsDateForDate = new Date(intervalStartTimestamp);
          const zonedDateForDate = fromDate(jsDateForDate, timezone);
          const dateKey = `${zonedDateForDate.year}-${String(zonedDateForDate.month).padStart(2, "0")}-${String(zonedDateForDate.day).padStart(2, "0")}`;

          dates.add(dateKey);

          if (!dataByDate.has(dateKey)) {
            dataByDate.set(dateKey, new Map());
          }
          // Store null values as well
          dataByDate.get(dateKey)!.set(timeKey, value);
        });

        // Sort dates (most recent first)
        const sortedDates = Array.from(dates).sort().reverse();

        // Build heatmap data points
        const heatmapPoints: HeatmapDataPoint[] = [];
        let min = Infinity;
        let max = -Infinity;

        sortedDates.forEach((dateKey) => {
          const timeData = dataByDate.get(dateKey)!;
          timeLabels.forEach((timeKey) => {
            const value = timeData.get(timeKey) ?? null;
            heatmapPoints.push({
              x: timeKey,
              y: dateKey,
              v: value,
            });

            if (value !== null) {
              min = Math.min(min, value);
              max = Math.max(max, value);
            }
          });
        });

        // Handle case where all values are null
        if (min === Infinity || max === -Infinity) {
          min = 0;
          max = 1;
        }

        setHeatmapData({
          data: heatmapPoints,
          min,
          max,
          xLabels: timeLabels,
          yLabels: sortedDates,
        });
        console.log("[HeatmapChart] Data processed, setting loading=false");
        setLoading(false);
      } catch (err) {
        console.error("Error fetching heatmap data:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setIsErrorModalOpen(true);
        setErrorType("server");
        setErrorDetails(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    };

    fetchData();
  }, [systemId, pointPath, timezone]);

  // Parse interval string to milliseconds
  function parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) return 0;

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
        return 0;
    }
  }

  // Get color for a normalized value (0-1)
  const getColor = (normalizedValue: number): string => {
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
              const normalized =
                (dataPoint.v - (heatmapData?.min || 0)) /
                ((heatmapData?.max || 1) - (heatmapData?.min || 0));
              cellColor = getColor(normalized);
            }

            const bodyText =
              dataPoint.v === null
                ? "No data"
                : `${dataPoint.v.toFixed(2)}${pointUnit}`;

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

            const localDate = new Date(date + "T00:00:00");
            // Dates are sorted most recent first, so last index is the oldest (first chronologically)
            const isFirstChronologically =
              index === (heatmapData?.yLabels.length ?? 0) - 1;
            const isFirstOfMonth = localDate.getDate() === 1;

            // Show month for first chronological date or first of month
            if (isFirstChronologically || isFirstOfMonth) {
              return format(localDate, "MMM EEE d");
            }

            // Regular format
            return format(localDate, "EEE d");
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

          const normalized =
            (value - (heatmapData?.min || 0)) /
            ((heatmapData?.max || 1) - (heatmapData?.min || 0));
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

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-gray-400">Loading heatmap...</div>
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
        <div ref={chartContainerRef} style={{ height: "600px" }}>
          <Chart type="matrix" data={chartData} options={chartOptions} />
        </div>

        {/* Color legend */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="text-xs text-gray-400">
            {heatmapData.min.toFixed(1)}
            {pointUnit}
          </span>
          <div
            className="h-4 rounded"
            style={{
              width: "200px",
              background: `linear-gradient(to right, ${getColor(0)}, ${getColor(0.25)}, ${getColor(0.5)}, ${getColor(0.75)}, ${getColor(1)})`,
            }}
          />
          <span className="text-xs text-gray-400">
            {heatmapData.max.toFixed(1)}
            {pointUnit}
          </span>
        </div>
      </div>
    </div>
  );
}
