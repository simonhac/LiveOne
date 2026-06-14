"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { historyQuery } from "@/lib/queries";
import ChartTooltip from "./ChartTooltip";
import PeriodSwitcher from "./PeriodSwitcher";
import ServerErrorModal from "./ServerErrorModal";
import { type ChartOptions } from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import "chartjs-adapter-date-fns";
import micromatch from "micromatch";
import {
  registerChartScaffold,
  buildShadingAnnotations,
  buildTimeScale,
  formatHoverTimestamp as formatHoverTimestampShared,
} from "@/lib/charts/scaffold";
import { buildLineDatasets } from "@/lib/charts/datasets";
import type { LineChartData as ChartData } from "@/lib/charts/types";

registerChartScaffold();

interface EnergyChartProps {
  className?: string;
  maxPowerHint?: number; // Max power in kW
  systemId: number; // System ID (e.g., 648, 1586)
  vendorType?: string; // Vendor type (e.g., 'enphase', 'selectronic')
  initialPeriod?: "1D" | "7D" | "30D"; // Initial period from URL
}

// Series patterns to request for a given period (energy mode = 30D/1d, else power mode).
function buildSeriesParam(isEnergyMode: boolean): string {
  if (isEnergyMode) {
    return [
      "source.solar/energy.delta",
      "load*/energy.delta",
      "bidi.grid/energy.delta",
      "bidi.battery/soc.{avg,min,max}",
    ].join(",");
  }
  return [
    "source.solar/power.avg",
    "load*/power.avg",
    "bidi.battery/power.avg",
    "bidi.grid/power.avg",
    "bidi.battery/soc.last",
  ].join(",");
}

/**
 * Pure transform: raw OpenNEM payload → windowed, unit-converted ChartData. Runs in a
 * component useMemo (not select), so it recomputes only on refetch or period change — the
 * `new Date()` window is therefore evaluated once per data change, keeping arrays stable.
 */
function buildChartData(
  rawHistory: any,
  timeRange: "1D" | "7D" | "30D",
): ChartData | null {
  if (!rawHistory || !Array.isArray(rawHistory.data)) return null;
  const isEnergyMode = timeRange === "30D";

  const findSeries = (pattern: string) =>
    rawHistory.data.find((d: any) => {
      const slashIndex = d.id.indexOf("/");
      if (slashIndex === -1) return false;
      const seriesPath = d.id.substring(slashIndex + 1);
      return micromatch.isMatch(seriesPath, pattern);
    });

  let solarData,
    loadData,
    batteryWData,
    batterySOCData,
    batterySOCMinData,
    batterySOCMaxData,
    gridData;

  if (isEnergyMode) {
    solarData =
      findSeries("source.solar*/energy.delta") ||
      findSeries("solar*/energy.delta");
    loadData = findSeries("load/energy.delta");
    batteryWData = null;
    batterySOCData = findSeries("bidi.battery/soc.avg");
    batterySOCMinData = findSeries("bidi.battery/soc.min");
    batterySOCMaxData = findSeries("bidi.battery/soc.max");
    gridData = findSeries("bidi.grid/energy.delta");
  } else {
    solarData =
      findSeries("source.solar*/power.avg") || findSeries("solar*/power.avg");
    loadData = findSeries("load/power.avg");
    batteryWData = findSeries("bidi.battery/power.avg");
    batterySOCData = findSeries("bidi.battery/soc.last");
    batterySOCMinData = null;
    batterySOCMaxData = null;
    gridData = findSeries("bidi.grid/power.avg");
  }

  const primaryData =
    solarData || loadData || batteryWData || batterySOCData || gridData;
  if (!primaryData) return null;

  const startTime = new Date(primaryData.history.firstInterval);
  const interval = primaryData.history.interval;
  if (!interval) throw new Error("No interval specified in API response");

  let intervalMs: number;
  if (interval === "1d") intervalMs = 24 * 60 * 60000;
  else if (interval === "30m") intervalMs = 30 * 60000;
  else if (interval === "5m") intervalMs = 5 * 60000;
  else if (interval === "1m") intervalMs = 60000;
  else throw new Error(`Unsupported interval: ${interval}`);

  const timestamps: Date[] = primaryData.history.data.map(
    (_: any, index: number) =>
      new Date(startTime.getTime() + index * intervalMs),
  );

  const currentTime = new Date();
  const windowHours =
    timeRange === "1D" ? 24 : timeRange === "7D" ? 24 * 7 : 24 * 30;
  const windowStart = new Date(
    currentTime.getTime() - windowHours * 60 * 60 * 1000,
  );

  const selectedIndices = timestamps
    .map((t, i) => ({ time: t, index: i }))
    .filter(({ time }) => time >= windowStart && time <= currentTime)
    .map(({ index }) => index);

  const convertToKw = (value: number | null, units: string): number | null => {
    if (value === null) return null;
    const unitsLower = units?.toLowerCase() || "";
    if (unitsLower === "w" || unitsLower === "wh") return value / 1000;
    return value;
  };

  return {
    timestamps: selectedIndices.map((i) => timestamps[i]),
    solar: solarData
      ? selectedIndices.map((i) =>
          convertToKw(solarData.history.data[i], solarData.units),
        )
      : selectedIndices.map(() => null),
    load: loadData
      ? selectedIndices.map((i) =>
          convertToKw(loadData.history.data[i], loadData.units),
        )
      : selectedIndices.map(() => null),
    batteryW: batteryWData
      ? selectedIndices.map((i) =>
          convertToKw(batteryWData.history.data[i], batteryWData.units),
        )
      : selectedIndices.map(() => null),
    batterySOC: batterySOCData
      ? selectedIndices.map((i) => batterySOCData.history.data[i])
      : selectedIndices.map(() => null),
    batterySOCMin: batterySOCMinData
      ? selectedIndices.map((i) => batterySOCMinData.history.data[i])
      : undefined,
    batterySOCMax: batterySOCMaxData
      ? selectedIndices.map((i) => batterySOCMaxData.history.data[i])
      : undefined,
    grid: gridData
      ? selectedIndices.map((i) =>
          convertToKw(gridData.history.data[i], gridData.units),
        )
      : undefined,
    mode: isEnergyMode ? "energy" : "power",
  } as ChartData;
}

export default function EnergyChart({
  className = "",
  maxPowerHint,
  systemId,
  initialPeriod,
}: EnergyChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState<{
    type: "connection" | "server" | null;
    details?: string;
  }>({ type: null });

  // Initialize timeRange from URL param or prop
  const getInitialTimeRange = () => {
    const urlPeriod = searchParams.get("period") as "1D" | "7D" | "30D" | null;
    if (urlPeriod && ["1D", "7D", "30D"].includes(urlPeriod)) {
      return urlPeriod;
    }
    return initialPeriod || "1D";
  };

  const [timeRange, setTimeRange] = useState<"1D" | "7D" | "30D">(
    getInitialTimeRange(),
  );
  const [hoveredData, setHoveredData] = useState<{
    solar: number | null;
    load: number | null;
    battery: number | null;
    grid: number | null;
    batterySOC: number | null;
    timestamp: Date | null;
  }>({
    solar: null,
    load: null,
    battery: null,
    grid: null,
    batterySOC: null,
    timestamp: null,
  });
  const chartRef = useRef<any>(null);

  // History data via React Query. The raw OpenNEM payload is cached; the windowing +
  // unit-conversion transform runs in a useMemo so the derived ChartData stays referentially
  // stable between renders and recomputes only on refetch (boundary-aligned) or period change.
  const requestInterval: "5m" | "30m" | "1d" =
    timeRange === "1D" ? "5m" : timeRange === "7D" ? "30m" : "1d";
  const duration =
    timeRange === "1D" ? "24h" : timeRange === "7D" ? "168h" : "30d";

  const {
    data: rawHistory,
    isPending,
    isError,
    error: queryError,
  } = useQuery(
    historyQuery({
      systemId,
      interval: requestInterval,
      last: duration,
      series: buildSeriesParam(requestInterval === "1d"),
    }),
  );

  const chartData = useMemo<ChartData | null>(
    () => buildChartData(rawHistory, timeRange),
    [rawHistory, timeRange],
  );

  const loading = isPending;
  const error = isError
    ? queryError instanceof Error
      ? queryError.message
      : "Failed to load chart data"
    : null;

  // Connection failures get the modal; HTTP errors show inline only (matches prior behavior).
  useEffect(() => {
    if (isError && queryError instanceof TypeError) {
      setServerError({ type: "connection" });
    }
  }, [isError, queryError]);

  // Define callbacks before any conditional returns
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleHover = useCallback(
    (event: any, activeElements: any[], chart: any) => {
      // Don't process if no chart data
      if (!chartData) return;

      // Clear any pending timeout
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }

      // Debounce the hover update
      hoverTimeoutRef.current = setTimeout(() => {
        if (activeElements && activeElements.length > 0) {
          const dataIndex = activeElements[0].index;
          const solarValue = chartData.solar[dataIndex]; // Already converted to kW/kWh by convertToKw()
          const loadValue = chartData.load[dataIndex]; // Already converted to kW/kWh by convertToKw()
          const batteryPowerValue =
            chartData.batteryW && chartData.batteryW[dataIndex] !== undefined
              ? chartData.batteryW[dataIndex]
              : null; // Already converted to kW by convertToKw()
          const gridValue =
            chartData.grid && chartData.grid[dataIndex] !== undefined
              ? chartData.grid[dataIndex]
              : null; // Already converted to kW/kWh by convertToKw()
          const batteryValue = chartData.batterySOC[dataIndex];
          const timestamp = chartData.timestamps[dataIndex];

          setHoveredData({
            solar: solarValue,
            load: loadValue,
            battery: batteryPowerValue,
            grid: gridValue,
            batterySOC: batteryValue,
            timestamp: timestamp,
          });
        } else {
          setHoveredData({
            solar: null,
            load: null,
            battery: null,
            grid: null,
            batterySOC: null,
            timestamp: null,
          });
        }
      }, 10); // Small debounce delay
    },
    [chartData],
  );

  // Calculate the time window for x-axis
  const { now, windowStart } = useMemo(() => {
    const now = new Date();
    let windowHours: number;
    if (timeRange === "1D") {
      windowHours = 24;
    } else if (timeRange === "7D") {
      windowHours = 24 * 7;
    } else {
      // 30D
      windowHours = 24 * 30;
    }
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    return { now, windowStart };
  }, [timeRange]);

  const options: ChartOptions<any> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index" as const,
        intersect: false,
      },
      onHover: handleHover,
      plugins: {
        legend: {
          display: false, // Hide the legend
        },
        tooltip: {
          enabled: false, // Disable the default tooltip since we're using our custom one
        },
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
          title: {
            display: false, // Hide the title
          },
          // Use maxPowerHint for power mode, auto-scale for energy mode
          suggestedMax: chartData?.mode === "energy" ? undefined : maxPowerHint,
          // Allow negative values for grid/battery charging
          // min: 0 removed to allow y-axis to go negative
          grid: {
            color: "rgb(55, 65, 81)", // gray-700
            display: true,
            drawOnChartArea: true,
          },
          ticks: {
            color: "rgb(156, 163, 175)", // gray-400
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
            },
            callback: function (value: any, index: any, ticks: any) {
              // Add unit only to the last (top) tick
              // Use kWh for energy mode, kW for power mode
              if (index === ticks.length - 1) {
                const unit = chartData?.mode === "energy" ? "kWh" : "kW";
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
          title: {
            display: false, // Hide the title
          },
          grid: {
            display: true,
            drawOnChartArea: false, // Don't draw y1 grid lines on chart area to avoid overlap
          },
          ticks: {
            color: "rgb(156, 163, 175)", // gray-400
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
            },
            callback: function (value: any, index: any, ticks: any) {
              // Add "%" only to the last (top) tick
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
    }),
    [handleHover, windowStart, now, timeRange, chartData?.mode, maxPowerHint],
  );

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // For energy mode, pad the SOC data to extend the fill to chart edges
  const paddedSOCData =
    chartData?.mode === "energy" &&
    chartData.batterySOCMin &&
    chartData.batterySOCMax
      ? (() => {
          // Get the first and last timestamps from the data
          const timestamps = [...chartData.timestamps];
          const firstTime = timestamps[0];
          const lastTime = timestamps[timestamps.length - 1];

          // Add padding timestamps (half day before/after to ensure coverage)
          const paddedTimestamps = [
            new Date(firstTime.getTime() - 12 * 60 * 60 * 1000), // 12 hours before
            ...timestamps,
            new Date(lastTime.getTime() + 12 * 60 * 60 * 1000), // 12 hours after
          ];

          // Extend the SOC values (use the same values at edges)
          const paddedSOCMin = [
            chartData.batterySOCMin[0],
            ...chartData.batterySOCMin,
            chartData.batterySOCMin[chartData.batterySOCMin.length - 1],
          ];

          const paddedSOCMax = [
            chartData.batterySOCMax[0],
            ...chartData.batterySOCMax,
            chartData.batterySOCMax[chartData.batterySOCMax.length - 1],
          ];

          return {
            timestamps: paddedTimestamps,
            min: paddedSOCMin,
            max: paddedSOCMax,
          };
        })()
      : null;

  const data: any = !chartData
    ? {}
    : {
        labels: chartData.timestamps,
        datasets: buildLineDatasets(chartData, paddedSOCData),
      };

  // Format timestamp based on time range (shared scaffold helper)
  const formatHoverTimestamp = (date: Date | null, isMobile: boolean = false) =>
    formatHoverTimestampShared(date, timeRange, isMobile);

  // Render the chart content based on state
  const renderChartContent = () => {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-gray-500">Loading chart...</div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-red-400">Error: {error}</div>
        </div>
      );
    }

    if (!chartData) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-gray-500">No chart data available</div>
        </div>
      );
    }

    // Normal chart display
    return (
      <>
        <div className="flex-1 min-h-0">
          {chartData.mode === "energy" ? (
            <Bar ref={chartRef} data={data} options={options} />
          ) : (
            <Line ref={chartRef} data={data} options={options} />
          )}
        </div>
        <div className="flex justify-center mt-2 px-2 sm:px-0">
          <ChartTooltip
            solar={hoveredData.solar}
            load={hoveredData.load}
            battery={hoveredData.battery}
            grid={hoveredData.grid}
            batterySOC={hoveredData.batterySOC}
            unit={chartData?.mode === "energy" ? "kWh" : "kW"}
            visible={true}
          />
        </div>
      </>
    );
  };

  return (
    <div
      className={`md:bg-gray-800 md:border md:border-gray-700 md:rounded py-1 px-0 md:p-4 flex flex-col ${className}`}
    >
      <div className="flex justify-end items-center mb-2 md:mb-3 px-1 md:px-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <span
            className="hidden sm:block text-xs text-gray-400 min-w-[200px] text-right whitespace-nowrap"
            style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
          >
            {formatHoverTimestamp(hoveredData.timestamp)}
          </span>
          <span
            className="sm:hidden text-xs text-gray-400 text-right whitespace-nowrap"
            style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
          >
            {formatHoverTimestamp(hoveredData.timestamp, true)}
          </span>
          <PeriodSwitcher
            value={timeRange}
            onChange={(newPeriod) => {
              setTimeRange(newPeriod);
              // Update URL with new period
              const params = new URLSearchParams(searchParams.toString());
              params.set("period", newPeriod);
              router.push(`?${params.toString()}`, { scroll: false });
            }}
          />
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
