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
import { CalendarX2 } from "lucide-react";
import { CHART_COLORS, LOAD_LABELS, getLoadColor } from "@/lib/chart-colors";
import { PointPath } from "@/lib/identifiers";
import micromatch from "micromatch";

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

interface SitePowerChartProps {
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
  seriesType?: "power" | "soc"; // Type of series: power/energy (stacked) or soc (overlay)
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

// Parse path using PointPath typed object
// Returns the parsed PointPath or null if not parseable
export function parsePath(path: string | null | undefined): PointPath | null {
  if (!path) return null;
  return PointPath.parse(path) || null;
}

// Filter series by point identifier pattern (glob-style)
// Pattern format: "bidi.battery.charge/power" or "source.solar*/power"
function filterByPointId(
  series: Array<{ id: string; label?: string; path?: string }>,
  pattern: string,
): typeof series {
  return series.filter((s) => s.path && micromatch.isMatch(s.path, pattern));
}

// Find first series matching point identifier pattern
function findByPointId(
  series: Array<{ id: string; label?: string; path?: string }>,
  pattern: string,
) {
  return series.find((s) => s.path && micromatch.isMatch(s.path, pattern));
}

// Color constants are now imported from @/lib/chart-colors

// Generate series configurations dynamically from available data
export function generateSeriesConfig(
  availableSeries: Array<{ id: string; label?: string; path?: string }>,
  mode: "load" | "generation",
): SeriesConfig[] {
  const configs: SeriesConfig[] = [];

  if (mode === "load") {
    // Find all load series
    const loadSeries = availableSeries
      .map((s) => ({ ...s, parsed: parsePath(s.path) }))
      .filter((s) => s.parsed?.type === "load");

    // Create config for each load
    loadSeries.forEach((series, idx) => {
      const pointPath = series.parsed!;
      const loadType = pointPath.extension || pointPath.subtype || "";
      // Use label from API if available, otherwise fallback to lookup table or capitalized load type
      // If loadType is empty (just "load" with no subtype), use "Load" as default
      const label =
        series.label ||
        (loadType ? LOAD_LABELS[loadType] : undefined) ||
        (loadType
          ? loadType.charAt(0).toUpperCase() + loadType.slice(1)
          : "Load");

      // Get color using centralized function
      const color = getLoadColor(loadType, label, idx);

      configs.push({
        id: series.id,
        label,
        color,
        order: idx,
      });
    });

    // Add rest of house placeholder (after loads, at the bottom of the load stack)
    configs.push({
      id: "rest_of_house",
      label: "Rest of House",
      color: CHART_COLORS.restOfHouse,
      order: loadSeries.length,
    });

    // Add battery charge (already split by site-data-processor)
    const batterySeries = findByPointId(
      availableSeries,
      "bidi.battery.charge/power",
    );
    if (batterySeries) {
      configs.push({
        id: batterySeries.id,
        label: "Battery Charge",
        color: CHART_COLORS.battery.main,
        // No dataTransform needed - site-data-processor already splits and transforms
        order: loadSeries.length + 1,
      });
    }

    // Add grid export (negative grid power)
    const gridSeries = findByPointId(availableSeries, "bidi.grid/power*");
    if (gridSeries) {
      configs.push({
        id: gridSeries.id,
        label: "Grid Export",
        color: CHART_COLORS.grid.main,
        dataTransform: (val: number) => (val < 0 ? Math.abs(val) : 0),
        order: loadSeries.length + 2,
      });
    }
  } else {
    // generation mode
    // Find solar series (matches source.solar, source.solar.local, source.solar.remote, etc.)
    const solarSeries = filterByPointId(availableSeries, "source.solar*/power*")
      .map((s) => ({ ...s, parsed: parsePath(s.path) }))
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
      const color =
        idx === 0 ? CHART_COLORS.solar.primary : CHART_COLORS.solar.secondary;

      configs.push({
        id: series.id,
        label,
        color,
        order: idx,
      });
    });

    // Add battery discharge (already split by site-data-processor)
    const batterySeries = findByPointId(
      availableSeries,
      "bidi.battery.discharge/power",
    );
    if (batterySeries) {
      configs.push({
        id: batterySeries.id,
        label: "Battery Discharge",
        color: CHART_COLORS.battery.main,
        // No dataTransform needed - site-data-processor already splits and transforms
        order: solarSeries.length,
      });
    }

    // Add grid import (positive grid power) - after battery
    const gridSeries = findByPointId(availableSeries, "bidi.grid/power*");
    if (gridSeries) {
      configs.push({
        id: gridSeries.id,
        label: "Grid Import",
        color: CHART_COLORS.grid.main,
        dataTransform: (val: number) => (val > 0 ? val : 0),
        order: solarSeries.length + 1,
      });
    }
  }

  return configs;
}

export default function SitePowerChart({
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
}: SitePowerChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
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
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
            },
            callback: function (value: any) {
              return value + "%";
            },
          },
        },
      },
    }),
    [
      handleHover,
      windowStart,
      now,
      timeRange,
      hoveredTimestamp,
      isBarChart,
      mode,
    ],
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

  const data: any = !chartData
    ? {}
    : {
        labels: chartData.timestamps,
        datasets: (() => {
          // Separate power/energy series from SoC series
          const powerSeries = chartData.series.filter(
            (s) => s.seriesType !== "soc",
          );
          const socSeries = chartData.series.filter(
            (s) => s.seriesType === "soc",
          );

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
        })(),
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

    if (!chartData) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="flex flex-col items-center gap-3">
            <CalendarX2 className="w-12 h-12 text-gray-500" />
            <p className="text-sm text-gray-300">No data available</p>
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
      className={`flex flex-col site-power-chart-container ${className}`}
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
