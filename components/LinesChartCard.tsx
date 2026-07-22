"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { historyQuery } from "@/lib/queries";
import ChartTooltip from "./ChartTooltip";
import ServerErrorModal from "./ServerErrorModal";
import DashboardChart from "./DashboardChart";
import type { LineChartData as ChartData } from "@/lib/charts/types";
import { buildSeriesParam, buildChartData } from "@/lib/charts/lines-data";
import { encodeHistoryWindow } from "@/lib/charts/history-window";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { useSettledWindow } from "@/lib/charts/useSettledWindow";
import { useChartFocus, nearestIndex } from "@/lib/charts/ChartFocusContext";

interface LinesChartCardProps {
  className?: string;
  maxPowerHint?: number; // Max power in kW
  systemId: number; // System ID (e.g., 648, 1586)
  /** System/area timezone offset (minutes) — drives the navigator label + historical URL encoding. */
  timezoneOffsetMin: number;
}

export default function LinesChartCard({
  className = "",
  maxPowerHint,
  systemId,
  timezoneOffsetMin,
}: LinesChartCardProps) {
  const [serverError, setServerError] = useState<{
    type: "connection" | "server" | null;
    details?: string;
  }>({ type: null });

  // Shared temporal-navigator state (period + historical window) from the URL. This is the INSTANT
  // desired window (the header label follows it immediately); the chart fetches a settled copy so a
  // rapid click-burst collapses to one request for the window landed on (see useSettledWindow).
  const {
    period: desiredPeriod,
    start: desiredStart,
    end: desiredEnd,
  } = useTemporalRange({
    timezoneOffsetMin,
  });
  const desiredWindow = useMemo(
    () => ({ period: desiredPeriod, start: desiredStart, end: desiredEnd }),
    [desiredPeriod, desiredStart, desiredEnd],
  );
  const [committedWindow, reportHistoryFetching] =
    useSettledWindow(desiredWindow);
  const { period, start, end } = committedWindow;
  const isHistoricalMode = !!(start || end);
  // Shared focus instant for this chart cluster — publish our hover here, and read it back so the
  // red focus line + the values tooltip follow whatever point is focused on ANY chart in the section.
  const { focusedTime, setFocusedTime } = useChartFocus();
  const chartRef = useRef<any>(null);

  // History data via React Query. The raw OpenNEM payload is cached; the windowing +
  // unit-conversion transform runs in a useMemo so the derived ChartData stays referentially
  // stable between renders and recomputes only on refetch (boundary-aligned) or period change.
  const requestInterval: "5m" | "30m" | "1d" =
    period === "1D" ? "5m" : period === "7D" ? "30m" : "1d";
  const duration = period === "1D" ? "24h" : period === "7D" ? "168h" : "30d";

  // Live (no window) → trailing `last` window with boundary refetch; historical → an explicit
  // settled window, encoded via the shared history-window encoder so it matches the site charts.
  const historicalWindow =
    isHistoricalMode && start && end
      ? encodeHistoryWindow(start, end, requestInterval)
      : null;

  const {
    data: rawHistory,
    isPending,
    isFetching,
    isError,
    error: queryError,
  } = useQuery(
    historyQuery({
      systemId,
      interval: requestInterval,
      series: buildSeriesParam(requestInterval === "1d"),
      timezoneOffsetMin,
      ...(historicalWindow
        ? {
            startTime: historicalWindow.startTime,
            endTime: historicalWindow.endTime,
          }
        : { last: duration }),
    }),
  );

  // Report the fetch state back to the committer so it advances to the next requested window only
  // once the current fetch settles (single-flight — see useSettledWindow).
  useEffect(() => {
    reportHistoryFetching(isFetching);
  }, [isFetching, reportHistoryFetching]);

  const chartData = useMemo<ChartData | null>(
    () =>
      buildChartData(
        rawHistory,
        period,
        start && end
          ? { start: new Date(start), end: new Date(end) }
          : undefined,
      ),
    [rawHistory, period, start, end],
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

      // Debounce the hover update. Publish the hovered instant to the shared focus; the displayed
      // values + red line derive from it below (so they also follow focus set by a sibling chart).
      hoverTimeoutRef.current = setTimeout(() => {
        if (activeElements && activeElements.length > 0) {
          const dataIndex = activeElements[0].index;
          setFocusedTime(chartData.timestamps[dataIndex] ?? null);
        } else {
          setFocusedTime(null);
        }
      }, 10); // Small debounce delay
    },
    [chartData, setFocusedTime],
  );

  // Values shown in the tooltip below the chart + the red focus line, derived from the shared focus
  // instant mapped onto THIS chart's grid (so remote focus from the stacked charts works too).
  const focusIndex = nearestIndex(chartData?.timestamps, focusedTime);
  const hoveredData =
    focusIndex != null && chartData
      ? {
          solar: chartData.solar[focusIndex] ?? null,
          load: chartData.load[focusIndex] ?? null,
          battery: chartData.batteryW?.[focusIndex] ?? null,
          grid: chartData.grid?.[focusIndex] ?? null,
          batterySOC: chartData.batterySOC[focusIndex] ?? null,
          timestamp: chartData.timestamps[focusIndex] ?? null,
        }
      : {
          solar: null,
          load: null,
          battery: null,
          grid: null,
          batterySOC: null,
          timestamp: null,
        };

  const handleMouseLeave = useCallback(() => {
    if (!("ontouchstart" in window)) setFocusedTime(null);
  }, [setFocusedTime]);

  // X-axis window: prefer the rendered data's actual extent (keeps the axis + daytime/weekday
  // shading aligned with historical data); else the requested window; else the live trailing window.
  const { now, windowStart } = useMemo(() => {
    if (chartData && chartData.timestamps.length > 0) {
      const ts = chartData.timestamps;
      return { windowStart: ts[0], now: ts[ts.length - 1] };
    }
    if (start && end) {
      return { windowStart: new Date(start), now: new Date(end) };
    }
    const now = new Date();
    const windowHours =
      period === "1D" ? 24 : period === "7D" ? 24 * 7 : 24 * 30;
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    return { now, windowStart };
  }, [chartData, start, end, period]);

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // For energy mode, pad the SOC data to extend the fill to chart edges. Guard on a non-empty
  // timestamps array: empty SoC arrays are still truthy, so without this a data-less window (new
  // device) would run the IIFE and crash on `timestamps[0].getTime()` (undefined).
  const paddedSOCData =
    chartData?.mode === "energy" &&
    chartData.timestamps.length > 0 &&
    chartData.batterySOCMin?.length &&
    chartData.batterySOCMax?.length
      ? (() => {
          // Get the first and last timestamps from the data
          const timestamps = [...chartData.timestamps];
          const firstTime = timestamps[0];
          const lastTime = timestamps[timestamps.length - 1];

          // Pad the band ±12h so its fill reaches the bar edges — but CLAMP to the x-axis window
          // [windowStart, now]. A pad point placed BEYOND the axis makes Chart.js's `fill: "+1"`
          // filler drop that end's lower boundary to the axis baseline (0%) — the trailing band
          // "collapse to 0" bug. Clamped, the band still reaches the edges without the artifact.
          const clampMs = (ms: number) =>
            Math.min(Math.max(ms, windowStart.getTime()), now.getTime());
          const paddedTimestamps = [
            new Date(clampMs(firstTime.getTime() - 12 * 60 * 60 * 1000)), // ≥ windowStart
            ...timestamps,
            new Date(clampMs(lastTime.getTime() + 12 * 60 * 60 * 1000)), // ≤ now
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
          timeRange={period}
          now={now}
          windowStart={windowStart}
          onHover={handleHover}
          hoveredTimestamp={hoveredData.timestamp}
          chartRef={chartRef}
          className="flex-1 min-h-0"
          onMouseLeave={handleMouseLeave}
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
