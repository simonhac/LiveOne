"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PeriodSwitcher from "./PeriodSwitcher";
import ServerErrorModal from "./ServerErrorModal";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  ChartOptions,
  Filler,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { format } from "date-fns";
import "chartjs-adapter-date-fns";
import annotationPlugin from "chartjs-plugin-annotation";
import { formatDateTime } from "@/lib/fe-date-format";
import { formatDateRange, fromUnixTimestamp } from "@/lib/date-utils";
import {
  parseSeriesPath,
  parseDeviceMetric,
  parseDeviceId,
} from "@/lib/series-path-parser";
import { CalendarX2 } from "lucide-react";

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
  annotationPlugin,
);

interface MondoPowerChartProps {
  className?: string;
  systemId: number;
  mode: "load" | "generation";
  title: string;
  initialPeriod?: "1D" | "7D" | "30D";
  period?: "1D" | "7D" | "30D"; // External period control
  onPeriodChange?: (period: "1D" | "7D" | "30D") => void;
  showPeriodSwitcher?: boolean;
  showDateDisplay?: boolean; // Whether to show the date display
  onDataChange?: (data: ChartData | null) => void; // Callback when data changes
  onHoverIndexChange?: (index: number | null) => void; // Callback when hover index changes
  hoveredIndex?: number | null; // External hover index to sync with other charts
  visibleSeries?: Set<string>; // Control which series are visible
  onVisibilityChange?: (visibleSeries: Set<string>) => void; // Callback when visibility changes
  data?: ChartData | null; // Pre-processed data from parent
  isLoading?: boolean; // External loading state from parent
}

export interface SeriesData {
  id: string;
  description: string;
  data: (number | null)[];
  color: string;
}

export interface ChartData {
  timestamps: Date[];
  series: SeriesData[];
  mode: "power" | "energy";
}

// Series configuration for data-driven approach
interface SeriesConfig {
  id: string;
  label: string;
  color: string;
  dataTransform?: (val: number) => number;
  order?: number;
}

// Parse series ID from format: liveone.{siteId}.{deviceId}.{metric}[.summariser]
// Returns: { type, subtype, extension } extracted from deviceId, or null if not parseable
export function parseSeriesId(
  seriesId: string,
): { type: string; subtype: string; extension?: string } | null {
  // Parse the full series path to get siteId and pointId
  const parsed = parseSeriesPath(seriesId);
  if (!parsed) return null;

  // Parse the pointId to extract deviceId (strips off metric/summariser)
  const deviceMetric = parseDeviceMetric(parsed.pointId);
  if (!deviceMetric) return null;

  // Parse the deviceId to get type, subtype, and extension
  const deviceIdParsed = parseDeviceId(deviceMetric.deviceId);
  if (!deviceIdParsed) return null;

  return {
    type: deviceIdParsed.type,
    subtype: deviceIdParsed.subtype || "",
    extension: deviceIdParsed.extension,
  };
}

// Color palettes for dynamic load discovery
const LOAD_COLORS = [
  "rgb(147, 51, 234)", // purple-600 (hvac)
  "rgb(239, 68, 68)", // red-500 (ev)
  "rgb(251, 146, 60)", // orange-400 (hws)
  "rgb(59, 130, 246)", // blue-500 (pool)
  "rgb(236, 72, 153)", // pink-500
  "rgb(168, 85, 247)", // violet-500
];

// Friendly labels for known load types
const LOAD_LABELS: Record<string, string> = {
  hvac: "A/C",
  ev: "EV Charger",
  hws: "Hot Water",
  pool: "Pool",
  spa: "Spa",
  oven: "Oven",
};

// Generate series configurations dynamically from available data
export function generateSeriesConfig(
  availableSeries: Array<{ id: string; label?: string }>,
  mode: "load" | "generation",
): SeriesConfig[] {
  const configs: SeriesConfig[] = [];

  if (mode === "load") {
    // Find all load series
    const loadSeries = availableSeries
      .map((s) => ({ ...s, parsed: parseSeriesId(s.id) }))
      .filter((s) => s.parsed?.type === "load");

    // Create config for each load
    loadSeries.forEach((series, idx) => {
      const { subtype, extension } = series.parsed!;
      const loadType = extension || subtype;
      // Use label from API if available, otherwise fallback to lookup table or capitalized load type
      const label =
        series.label ||
        LOAD_LABELS[loadType] ||
        loadType.charAt(0).toUpperCase() + loadType.slice(1);
      const color = LOAD_COLORS[idx % LOAD_COLORS.length];

      configs.push({
        id: series.id,
        label,
        color,
        order: idx,
      });
    });

    // Add rest of house placeholder (after loads)
    configs.push({
      id: "rest_of_house",
      label: "Rest of House",
      color: "rgb(156, 163, 175)", // gray-400
      order: loadSeries.length,
    });

    // Add battery charge (negative battery power)
    const batterySeries = availableSeries.find((s) => {
      const parsed = parseSeriesId(s.id);
      return parsed?.type === "bidi" && parsed?.subtype === "battery";
    });
    if (batterySeries) {
      configs.push({
        id: batterySeries.id,
        label: "Battery Charge",
        color: "rgb(34, 211, 238)", // cyan-400
        dataTransform: (val: number) => (val < 0 ? Math.abs(val) : 0),
        order: loadSeries.length + 1,
      });
    }

    // Add grid export (negative grid power)
    const gridSeries = availableSeries.find((s) => {
      const parsed = parseSeriesId(s.id);
      return parsed?.type === "bidi" && parsed?.subtype === "grid";
    });
    if (gridSeries) {
      configs.push({
        id: gridSeries.id,
        label: "Grid Export",
        color: "rgb(74, 222, 128)", // green-400
        dataTransform: (val: number) => (val < 0 ? Math.abs(val) : 0),
        order: loadSeries.length + 2,
      });
    }
  } else {
    // generation mode
    // Find solar series
    const solarSeries = availableSeries
      .map((s) => ({ ...s, parsed: parseSeriesId(s.id) }))
      .filter(
        (s) => s.parsed?.type === "source" && s.parsed?.subtype === "solar",
      )
      .sort((a, b) => {
        // Sort by extension: local first, then remote
        const aExt = a.parsed?.extension || "";
        const bExt = b.parsed?.extension || "";
        return aExt.localeCompare(bExt);
      });

    solarSeries.forEach((series, idx) => {
      const extension = series.parsed?.extension || "";
      const label = extension
        ? `Solar ${extension.charAt(0).toUpperCase() + extension.slice(1)}`
        : "Solar";
      const color = idx === 0 ? "rgb(254, 240, 138)" : "rgb(245, 158, 11)"; // yellow-200 / amber-500

      configs.push({
        id: series.id,
        label,
        color,
        order: idx,
      });
    });

    // Add battery discharge (positive battery power) - before grid import
    const batterySeries = availableSeries.find((s) => {
      const parsed = parseSeriesId(s.id);
      return parsed?.type === "bidi" && parsed?.subtype === "battery";
    });
    if (batterySeries) {
      configs.push({
        id: batterySeries.id,
        label: "Battery Discharge",
        color: "rgb(96, 165, 250)", // blue-400
        dataTransform: (val: number) => (val > 0 ? val : 0),
        order: solarSeries.length,
      });
    }

    // Add grid import (positive grid power) - after battery
    const gridSeries = availableSeries.find((s) => {
      const parsed = parseSeriesId(s.id);
      return parsed?.type === "bidi" && parsed?.subtype === "grid";
    });
    if (gridSeries) {
      configs.push({
        id: gridSeries.id,
        label: "Grid Import",
        color: "rgb(248, 113, 113)", // red-400
        dataTransform: (val: number) => (val > 0 ? val : 0),
        order: solarSeries.length + 1,
      });
    }
  }

  return configs;
}

export default function MondoPowerChart({
  className = "",
  systemId,
  mode,
  title,
  initialPeriod,
  period: externalPeriod,
  onPeriodChange,
  showPeriodSwitcher = true,
  onDataChange,
  onHoverIndexChange,
  hoveredIndex: externalHoveredIndex,
  visibleSeries: externalVisibleSeries,
  onVisibilityChange,
  data: externalData,
  isLoading: externalIsLoading,
}: MondoPowerChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{
    type: "connection" | "server" | null;
    details?: string;
  }>({ type: null });

  const getInitialTimeRange = () => {
    const urlPeriod = searchParams.get("period") as "1D" | "7D" | "30D" | null;
    if (urlPeriod && ["1D", "7D", "30D"].includes(urlPeriod)) {
      return urlPeriod;
    }
    return initialPeriod || "1D";
  };

  const [internalTimeRange, setInternalTimeRange] = useState<
    "1D" | "7D" | "30D"
  >(getInitialTimeRange());

  // Use external period if provided, otherwise use internal state
  const timeRange = externalPeriod || internalTimeRange;
  const [hoveredTimestamp, setHoveredTimestamp] = useState<Date | null>(null);
  const chartRef = useRef<any>(null);

  // Initialize visible series - all series visible by default
  // We'll populate this dynamically when data arrives
  const [internalVisibleSeries, setInternalVisibleSeries] = useState<
    Set<string>
  >(new Set());

  // Use external visibility if provided, otherwise use internal state
  const visibleSeries = externalVisibleSeries ?? internalVisibleSeries;

  // Compute effective visibility - if empty, show all series
  const effectiveVisibleSeries = useMemo(() => {
    if (visibleSeries.size === 0 && chartData) {
      return new Set(chartData.series.map((s) => s.id));
    }
    return visibleSeries;
  }, [visibleSeries, chartData]);

  // Sync external hovered index with internal timestamp
  useEffect(() => {
    if (externalHoveredIndex !== undefined && chartData) {
      if (
        externalHoveredIndex !== null &&
        chartData.timestamps[externalHoveredIndex]
      ) {
        setHoveredTimestamp(chartData.timestamps[externalHoveredIndex]);
      } else {
        setHoveredTimestamp(null);
      }
    }
  }, [externalHoveredIndex, chartData]);

  const lastHoverIndexRef = useRef<number | null>(null);

  const handleHover = useCallback(
    (event: any, activeElements: any[], chart: any) => {
      if (!chartData) return;

      if (activeElements && activeElements.length > 0) {
        const dataIndex = activeElements[0].index;

        // Only update if index actually changed (reduces jitter)
        if (lastHoverIndexRef.current !== dataIndex) {
          lastHoverIndexRef.current = dataIndex;
          const timestamp = chartData.timestamps[dataIndex];
          setHoveredTimestamp(timestamp);
          if (onHoverIndexChange) {
            onHoverIndexChange(dataIndex);
          }
        }
      } else {
        if (lastHoverIndexRef.current !== null) {
          lastHoverIndexRef.current = null;
          setHoveredTimestamp(null);
          if (onHoverIndexChange) {
            onHoverIndexChange(null);
          }
        }
      }
    },
    [chartData, onHoverIndexChange],
  );

  const { now, windowStart } = useMemo(() => {
    // When chartData is available, use its actual timestamp range
    // This ensures historical data is displayed correctly
    if (chartData && chartData.timestamps && chartData.timestamps.length > 0) {
      const timestamps = chartData.timestamps;
      return {
        windowStart: timestamps[0],
        now: timestamps[timestamps.length - 1],
      };
    }

    // Otherwise, use current time window (for initial render or live mode)
    const now = new Date();
    let windowHours: number;
    if (timeRange === "1D") {
      windowHours = 24;
    } else if (timeRange === "7D") {
      windowHours = 24 * 7;
    } else {
      windowHours = 24 * 30;
    }
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    return { now, windowStart };
  }, [timeRange, chartData]);

  // Determine if we should use bar chart (for energy/daily data)
  const isBarChart = chartData?.mode === "energy";

  const options: ChartOptions<any> = useMemo(
    () => ({
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
      onHover: handleHover,
      // Bar chart specific configuration
      ...(isBarChart && {
        barPercentage: 0.95, // Increase bar width (default 0.9)
        categoryPercentage: 0.95, // Increase category width (default 0.8)
      }),
      plugins: {
        legend: {
          display: false, // Legend now shown in the table
        },
        tooltip: {
          enabled: false,
        },
        annotation: {
          animation: false, // Disable animation for immediate updates
          annotations: (() => {
            const annotations: any[] = [];

            if (timeRange === "30D") {
              const daysToShow = 31;
              for (let i = 0; i < daysToShow; i++) {
                const day = new Date(now);
                day.setDate(day.getDate() - i);
                day.setHours(0, 0, 0, 0);

                const dayOfWeek = day.getDay();

                if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                  const dayEnd = new Date(day);
                  dayEnd.setHours(23, 59, 59, 999);

                  if (dayEnd > windowStart && day < now) {
                    annotations.push({
                      type: "box",
                      xMin: Math.max(day.getTime(), windowStart.getTime()),
                      xMax: Math.min(dayEnd.getTime(), now.getTime()),
                      backgroundColor: "rgba(255, 255, 255, 0.07)",
                      borderWidth: 0,
                    });
                  }
                }
              }
            } else {
              const daysToShow = timeRange === "1D" ? 2 : 8;
              for (let i = 0; i < daysToShow; i++) {
                const dayStart = new Date(now);
                dayStart.setDate(dayStart.getDate() - i);
                dayStart.setHours(7, 0, 0, 0);

                const dayEnd = new Date(now);
                dayEnd.setDate(dayEnd.getDate() - i);
                dayEnd.setHours(22, 0, 0, 0);

                if (dayEnd > windowStart && dayStart < now) {
                  annotations.push({
                    type: "box",
                    xMin: Math.max(dayStart.getTime(), windowStart.getTime()),
                    xMax: Math.min(dayEnd.getTime(), now.getTime()),
                    backgroundColor: "rgba(255, 255, 255, 0.07)",
                    borderWidth: 0,
                  });
                }
              }
            }

            // Add vertical line for hover position
            if (hoveredTimestamp) {
              annotations.push({
                type: "line",
                scaleID: "x",
                value: hoveredTimestamp.getTime(),
                borderColor: "rgb(239, 68, 68)", // Red color
                borderWidth: 1,
                borderDash: [], // Solid line
              });
            }

            return annotations;
          })(),
        },
      },
      scales: {
        x: {
          type: "time",
          min: windowStart.getTime(),
          max: now.getTime(),
          time: {
            unit: timeRange === "1D" ? "hour" : "day",
            displayFormats: {
              hour: "HH:mm",
              day: "MMM d",
            },
          },
          grid: {
            color: "rgb(55, 65, 81)",
            display: true,
            drawOnChartArea: true,
            drawTicks: true,
          },
          ticks: {
            color: "rgb(156, 163, 175)",
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
              lineHeight: 1.4,
            },
            maxRotation: 0,
            minRotation: 0,
            align: timeRange !== "1D" ? "start" : "center",
            padding: timeRange === "30D" ? 6 : 4,
            autoSkip: timeRange === "1D",
            source: "auto",
            callback: function (value: any, index: any, ticks: any) {
              const date = new Date(value);
              if (timeRange === "30D") {
                const totalDays = ticks.length;
                let skipInterval = 2;

                if (totalDays > 20) skipInterval = 3;
                if (totalDays > 25) skipInterval = 4;

                if (index % skipInterval !== 0) {
                  return "     ";
                } else {
                  const dayName = format(date, "EEE");
                  const dayDate = format(date, "d MMM");
                  return [dayName, dayDate];
                }
              } else if (timeRange === "7D") {
                const dayName = format(date, "EEE");
                const dayDate = format(date, "d MMM");
                return [dayName, dayDate];
              } else if (timeRange === "1D") {
                if (index % 2 !== 0) {
                  return "\u200B";
                }
                return format(date, "HH:mm");
              }
            },
          },
        },
        y: {
          type: "linear" as const,
          display: true,
          position: "left" as const,
          stacked: true,
          title: {
            display: false,
          },
          min: 0,
          grid: {
            color: "rgb(55, 65, 81)",
            display: true,
            drawOnChartArea: true,
          },
          ticks: {
            color: "rgb(156, 163, 175)",
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
            },
            callback: function (value: any, index: any, ticks: any) {
              if (index === ticks.length - 1) {
                return value + " kW";
              }
              return value;
            },
          },
        },
      },
    }),
    [handleHover, windowStart, now, timeRange, hoveredTimestamp, isBarChart],
  );

  // Use external data when provided
  useEffect(() => {
    // When using external data, we need to manage loading state differently
    if (externalData !== undefined) {
      if (externalData === null) {
        // If external data is null, check if parent is still loading
        if (externalIsLoading) {
          // Parent is still loading, keep spinner
          setLoading(true);
        } else {
          // Parent finished loading but data is null (no data available)
          setLoading(false);
        }
        setChartData(null);
      } else {
        // We have actual data
        setChartData(externalData);
        setLoading(false);
      }
    }
  }, [externalData, externalIsLoading, mode]);

  // Delay showing spinner to avoid flash on quick loads
  useEffect(() => {
    let timerId: NodeJS.Timeout;

    if (loading) {
      // Start a timer when loading becomes true
      timerId = setTimeout(() => {
        setShowSpinner(true);
      }, 1000);
    } else {
      // Immediately hide spinner when loading is done
      setShowSpinner(false);
    }

    return () => {
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [loading]);

  // Call onDataChange when chart data updates
  useEffect(() => {
    if (onDataChange) {
      onDataChange(chartData);
    }
  }, [chartData, onDataChange]);

  useEffect(() => {
    // Skip fetching if we're using external data
    if (externalData !== undefined) return;

    let abortController = new AbortController();

    const fetchData = async () => {
      abortController = new AbortController();

      try {
        let requestInterval: string;
        let duration: string;

        if (timeRange === "1D") {
          requestInterval = "5m";
          duration = "24h";
        } else if (timeRange === "7D") {
          requestInterval = "30m";
          duration = "168h";
        } else {
          requestInterval = "1d";
          duration = "30d";
        }

        const apiUrl = `/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId.toString()}`;

        const response = await fetch(apiUrl, {
          credentials: "same-origin",
          signal: abortController.signal,
        });

        if (!response.ok) {
          const contentType = response.headers.get("content-type");
          if (contentType && !contentType.includes("application/json")) {
            throw new Error("Session expired - please refresh the page");
          }
          if (response.status === 401) {
            throw new Error("Not authenticated - please log in");
          }
          throw new Error(`Failed to fetch data: ${response.status}`);
        }

        const data = await response.json();

        const isEnergyMode = requestInterval === "1d";

        // Filter to only power series
        const powerSeries = data.data.filter((d: any) => d.type === "power");

        // Generate series configuration dynamically from available data
        const seriesConfig = generateSeriesConfig(powerSeries, mode);

        // Initialize visible series if not set yet
        let currentVisibleSeries =
          externalVisibleSeries ?? internalVisibleSeries;
        if (currentVisibleSeries.size === 0) {
          currentVisibleSeries = new Set(seriesConfig.map((s) => s.id));
          setInternalVisibleSeries(currentVisibleSeries);
          if (onVisibilityChange) {
            onVisibilityChange(currentVisibleSeries);
          }
        }

        // Create a map of available series by their full ID
        const seriesMap = new Map<string, any>();
        powerSeries.forEach((series: any) => {
          seriesMap.set(series.id, series);
        });

        // Get first available series to extract timestamps
        const firstSeries = powerSeries[0];
        if (!firstSeries) {
          throw new Error("No data series available");
        }
        const startTimeString = firstSeries.history.start;
        const startTime = new Date(startTimeString);
        const interval = firstSeries.history.interval;

        let intervalMs: number;
        if (interval === "1d") {
          intervalMs = 24 * 60 * 60000;
        } else if (interval === "30m") {
          intervalMs = 30 * 60000;
        } else if (interval === "5m") {
          intervalMs = 5 * 60000;
        } else if (interval === "1m") {
          intervalMs = 60000;
        } else {
          throw new Error(`Unsupported interval: ${interval}`);
        }

        const timestamps = firstSeries.history.data.map(
          (_: any, index: number) =>
            new Date(startTime.getTime() + index * intervalMs),
        );

        // Filter to selected time range
        const currentTime = new Date();
        let windowHours: number;
        if (timeRange === "1D") {
          windowHours = 24;
        } else if (timeRange === "7D") {
          windowHours = 24 * 7;
        } else {
          windowHours = 24 * 30;
        }
        const windowStart = new Date(
          currentTime.getTime() - windowHours * 60 * 60 * 1000,
        );

        const selectedIndices = timestamps
          .map((t: Date, i: number) => ({ time: t, index: i }))
          .filter(
            ({ time }: { time: Date; index: number }) =>
              time >= windowStart && time <= currentTime,
          )
          .map(({ index }: { time: Date; index: number }) => index);

        // Build series data based on configuration
        const seriesData: SeriesData[] = [];

        // For rest of house calculation, we'll need to accumulate values
        let measuredLoadsSum: (number | null)[] | null = null;
        let batteryChargeValues: (number | null)[] | null = null;
        let gridExportValues: (number | null)[] | null = null;
        let totalGenerationValues: (number | null)[] | null = null;

        // Process each configured series
        seriesConfig.forEach((config) => {
          // Special handling for calculated series
          if (config.id === "rest_of_house" && mode === "load") {
            // We'll calculate this after processing all other series
            return;
          }

          // Find the matching series in our data
          const dataSeries = seriesMap.get(config.id);
          if (!dataSeries) return; // Skip if series not found in data

          // Extract the data for selected indices and convert from W to kW
          let seriesValues = selectedIndices.map((i: number) => {
            const val = dataSeries.history.data[i];
            return val === null ? null : val / 1000; // Convert W to kW
          });

          // Apply any data transformation (e.g., for battery/grid positive/negative split)
          if (config.dataTransform) {
            seriesValues = seriesValues.map((val: number | null) =>
              val === null ? null : config.dataTransform!(val),
            );
          }

          // Accumulate values for rest of house calculation (load mode)
          if (mode === "load") {
            const parsed = parseSeriesId(config.id);
            if (parsed?.type === "load") {
              // Accumulate measured loads
              if (!measuredLoadsSum) {
                measuredLoadsSum = seriesValues.slice();
              } else {
                seriesValues.forEach((val: number | null, idx: number) => {
                  if (measuredLoadsSum![idx] === null || val === null) {
                    measuredLoadsSum![idx] = null;
                  } else {
                    measuredLoadsSum![idx] =
                      (measuredLoadsSum![idx] ?? 0) + (val ?? 0);
                  }
                });
              }
            } else if (
              parsed?.type === "bidi" &&
              parsed?.subtype === "battery" &&
              config.label === "Battery Charge"
            ) {
              batteryChargeValues = seriesValues;
            } else if (
              parsed?.type === "bidi" &&
              parsed?.subtype === "grid" &&
              config.label === "Grid Export"
            ) {
              gridExportValues = seriesValues;
            }
          }

          seriesData.push({
            id: config.id,
            description: config.label,
            data: seriesValues,
            color: config.color,
          });
        });

        // Calculate rest of house for load mode
        if (mode === "load") {
          // Find solar, grid, and battery series using the new structure
          const solarSeriesList = Array.from(seriesMap.values()).filter((s) => {
            const parsed = parseSeriesId(s.id);
            return parsed?.type === "source" && parsed?.subtype === "solar";
          });

          const gridSeries = Array.from(seriesMap.values()).find((s) => {
            const parsed = parseSeriesId(s.id);
            return parsed?.type === "bidi" && parsed?.subtype === "grid";
          });

          const battSeries = Array.from(seriesMap.values()).find((s) => {
            const parsed = parseSeriesId(s.id);
            return parsed?.type === "bidi" && parsed?.subtype === "battery";
          });

          if (solarSeriesList.length > 0 || gridSeries || battSeries) {
            totalGenerationValues = selectedIndices.map((i: number) => {
              // Sum all solar arrays
              let totalSolar = 0;
              let hasNullSolar = false;
              for (const solarSeries of solarSeriesList) {
                const solarRaw = solarSeries.history.data[i];
                if (solarRaw === null) {
                  hasNullSolar = true;
                  break;
                }
                totalSolar += solarRaw / 1000; // Convert W to kW
              }

              const gridValRaw = gridSeries ? gridSeries.history.data[i] : 0;
              const battValRaw = battSeries ? battSeries.history.data[i] : 0;

              // If any critical value is null, we can't calculate total
              if (hasNullSolar || gridValRaw === null || battValRaw === null) {
                return null;
              }

              // Convert from W to kW
              const gridVal = gridValRaw / 1000;
              const battVal = battValRaw / 1000;

              const gridImport = Math.max(0, gridVal);
              const battDischarge = Math.max(0, battVal);
              return totalSolar + gridImport + battDischarge;
            });

            // Calculate rest of house: Total Generation - (Measured Loads + Battery Charge + Grid Export)
            const restOfHouseValues = selectedIndices.map(
              (_: number, idx: number) => {
                const totalGen = totalGenerationValues![idx];
                const measuredLoads = measuredLoadsSum?.[idx];
                const battCharge = batteryChargeValues?.[idx];
                const gridExp = gridExportValues?.[idx];

                // If any component is null, we can't calculate rest of house
                if (
                  totalGen === null ||
                  measuredLoads === null ||
                  battCharge === null ||
                  gridExp === null
                ) {
                  return null;
                }

                const restOfHouse =
                  totalGen -
                  ((measuredLoads ?? 0) + (battCharge ?? 0) + (gridExp ?? 0));
                // Only show positive values (negative would indicate measurement error)
                return Math.max(0, restOfHouse);
              },
            );

            // Add rest of house to series data
            const restOfHouseConfig = seriesConfig.find(
              (c) => c.id === "rest_of_house",
            );
            if (restOfHouseConfig) {
              seriesData.push({
                id: "rest_of_house",
                description: restOfHouseConfig.label,
                data: restOfHouseValues,
                color: restOfHouseConfig.color,
              });
            }
          }
        }

        // Sort by order property
        seriesData.sort((a, b) => {
          const aConfig = seriesConfig.find((c) => c.id === a.id);
          const bConfig = seriesConfig.find((c) => c.id === b.id);
          return (aConfig?.order ?? 999) - (bConfig?.order ?? 999);
        });

        if (seriesData.length === 0) {
          throw new Error("No data series available for the selected mode");
        }

        setChartData({
          timestamps: selectedIndices.map((i: number) => timestamps[i]),
          series: seriesData,
          mode: isEnergyMode ? "energy" : "power",
        });
        setLoading(false);
      } catch (err: any) {
        if (err.name === "AbortError") {
          return;
        }
        console.error("Error fetching chart data:", err);

        if (err instanceof TypeError && err.message === "Failed to fetch") {
          setServerError({ type: "connection" });
          setError("Unable to connect to server");
        } else {
          setError(
            err instanceof Error ? err.message : "Failed to load chart data",
          );
        }
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000);

    return () => {
      clearInterval(interval);
      abortController.abort();
    };
  }, [timeRange, systemId, mode, externalData]);

  const data: any = !chartData
    ? {}
    : {
        labels: chartData.timestamps,
        datasets: chartData.series
          .filter((series) => effectiveVisibleSeries.has(series.id)) // Filter by visibility
          .map((series, idx) => {
            const baseConfig = {
              label: series.description, // Description already contains the display label
              data: series.data, // Already in kW from earlier conversion
              backgroundColor: series.color, // Use solid color
              yAxisID: "y",
              stack: "stack0", // Ensure all datasets stack together
              order: idx,
            };

            if (isBarChart) {
              // Bar chart configuration
              return {
                ...baseConfig,
                borderColor: series.color,
                borderWidth: 0,
              };
            } else {
              // Line chart configuration
              return {
                ...baseConfig,
                borderColor: series.color,
                tension: 0, // Use straight lines instead of curved
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 0, // No dots on hover either
                fill: "stack", // Fill according to stack configuration
              };
            }
          }),
      };

  const formatHoverTimestamp = (
    date: Date | null,
    isMobile: boolean = false,
  ) => {
    if (!date) {
      // When not hovering, show the date range of the displayed data
      // Note: This function is not currently used since date display moved to parent component
      return "";
    }

    if (timeRange === "30D") {
      return format(date, isMobile ? "EEE, d MMM" : "EEE, d MMM yyyy");
    } else if (timeRange === "7D") {
      return format(
        date,
        isMobile ? "EEE, d MMM h:mma" : "EEE, d MMM yyyy h:mma",
      );
    } else {
      return format(date, "h:mma");
    }
  };

  const handleMouseLeave = useCallback(() => {
    // Only reset hover state on desktop (not touch devices)
    // On mobile, we want the hover line to persist until next tap
    if (!("ontouchstart" in window)) {
      setHoveredTimestamp(null);
      if (onHoverIndexChange) {
        onHoverIndexChange(null);
      }
    }
  }, [onHoverIndexChange]);

  const renderChartContent = () => {
    if (loading && showSpinner) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400"></div>
        </div>
      );
    }

    if (loading && !showSpinner) {
      // Still loading but spinner delay hasn't elapsed - show nothing
      return <div className="flex-1 min-h-0" />;
    }

    if (error || !chartData) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="flex flex-col items-center gap-3">
            <CalendarX2 className="w-12 h-12 text-gray-500" />
            <p className="text-sm text-gray-300">
              {error ? "Unable to load data" : "No data available"}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        className="flex-1 min-h-0 w-full overflow-hidden"
        onMouseLeave={handleMouseLeave}
      >
        {isBarChart ? (
          <Bar ref={chartRef} data={data} options={options} />
        ) : (
          <Line ref={chartRef} data={data} options={options} />
        )}
      </div>
    );
  };

  return (
    <div
      className={`flex flex-col mondo-power-chart-container ${className}`}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex justify-between items-center mb-2 md:mb-3 px-1 md:px-0">
        <h3 className="text-sm font-medium text-gray-300">{title}</h3>
        <div className="flex items-center gap-2">
          {showPeriodSwitcher && (
            <PeriodSwitcher
              value={timeRange}
              onChange={(newPeriod) => {
                if (onPeriodChange) {
                  onPeriodChange(newPeriod);
                } else {
                  setInternalTimeRange(newPeriod);
                  const params = new URLSearchParams(searchParams.toString());
                  params.set("period", newPeriod);
                  router.push(`?${params.toString()}`, { scroll: false });
                }
              }}
            />
          )}
        </div>
      </div>
      {renderChartContent()}

      <ServerErrorModal
        isOpen={serverError.type !== null}
        onClose={() => setServerError({ type: null })}
        errorType={serverError.type}
        errorDetails={serverError.details}
      />
    </div>
  );
}
