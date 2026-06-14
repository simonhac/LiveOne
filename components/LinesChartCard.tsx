"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { historyQuery } from "@/lib/queries";
import ChartTooltip from "./ChartTooltip";
import PeriodSwitcher from "./PeriodSwitcher";
import ServerErrorModal from "./ServerErrorModal";
import { formatHoverTimestamp as formatHoverTimestampShared } from "@/lib/charts/scaffold";
import DashboardChart from "./DashboardChart";
import type { LineChartData as ChartData } from "@/lib/charts/types";
import { buildSeriesParam, buildChartData } from "@/lib/charts/lines-data";

interface LinesChartCardProps {
  className?: string;
  maxPowerHint?: number; // Max power in kW
  systemId: number; // System ID (e.g., 648, 1586)
  initialPeriod?: "1D" | "7D" | "30D"; // Initial period from URL
}

export default function LinesChartCard({
  className = "",
  maxPowerHint,
  systemId,
  initialPeriod,
}: LinesChartCardProps) {
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
        <DashboardChart
          variant="lines"
          chartData={chartData}
          paddedSOCData={paddedSOCData}
          maxPowerHint={maxPowerHint}
          timeRange={timeRange}
          now={now}
          windowStart={windowStart}
          onHover={handleHover}
          chartRef={chartRef}
          className="flex-1 min-h-0"
        />
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
