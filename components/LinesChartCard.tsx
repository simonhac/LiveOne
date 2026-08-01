"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { historyQuery, siteDataQuery } from "@/lib/queries";
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
  systemId: number; // Device ID (e.g., 648, 1586)
  /** Device/area timezone offset (minutes) — drives the navigator label + historical URL encoding. */
  timezoneOffsetMin: number;
  /**
   * True ⇒ a SiteChartsGroup for this same handle is mounted and driving `siteDataQuery`, so for D/W
   * this chart reads THAT payload instead of firing its own `/api/history` (see the fetch note
   * below). Undefined/false ⇒ nothing else is fetching site data, so the own-query path is used.
   */
  sharedSiteData?: boolean;
}

export default function LinesChartCard({
  className = "",
  maxPowerHint,
  systemId,
  timezoneOffsetMin,
  sharedSiteData,
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
    period === "D" ? "5m" : period === "W" ? "30m" : "1d";
  // `duration` (the `last=` live window) is only used by D/W — M/Y always carry an explicit
  // `start`/`end` window and take the `encodeHistoryWindow` branch below.
  const duration = period === "D" ? "24h" : period === "W" ? "168h" : "30d";

  // Live (no window) → trailing `last` window with boundary refetch; historical → an explicit
  // settled window, encoded via the shared history-window encoder so it matches the site charts.
  const historicalWindow =
    isHistoricalMode && start && end
      ? encodeHistoryWindow(start, end, requestInterval)
      : null;

  // Ride the section's site-data fetch instead of issuing our own, when one exists and covers us.
  //
  // The site fetch (`lib/site-data-processor.ts`) requests `*/power.avg,bidi.battery/soc.last` over
  // the SAME interval and window as this chart for D (5m/24h) and W (30m/168h) — a strict superset
  // of `buildSeriesParam(false)`, and historical windows go through the same `encodeHistoryWindow`.
  // So for D/W the second `/api/history` was pure duplication; we read `rawSeries` off that payload
  // and hand it to the identical `buildChartData` below. Same pattern as `tiles/hot-water.tsx`.
  //
  // 🛑 D/W ONLY. M/Y switch this chart to energy mode, where `buildSeriesParam(true)` asks for
  // `*/energy.delta` + `bidi.battery/soc.{avg,min,max}` — series the site fetch does NOT request at
  // `1d`. Widening it there would cost every dashboard's M/Y view, so M/Y keep their own query.
  const useShared = !!sharedSiteData && (period === "D" || period === "W");

  const {
    data: siteData,
    isPending: sitePending,
    isFetching: siteFetching,
    isError: siteIsError,
    error: siteError,
  } = useQuery(
    siteDataQuery({
      systemId,
      period,
      // The COMMITTED window, matching what SiteChartsCard passes — same key, one shared fetch, and
      // the two `useSettledWindow` committers then observe one `isFetching`.
      start,
      end,
      timezoneOffsetMin,
      enabled: useShared,
    }),
  );

  const {
    data: rawHistory,
    isPending: historyPending,
    isFetching: historyFetching,
    isError: historyIsError,
    error: historyError,
  } = useQuery(
    historyQuery({
      systemId,
      interval: requestInterval,
      series: buildSeriesParam(requestInterval === "1d"),
      timezoneOffsetMin,
      enabled: !useShared,
      ...(historicalWindow
        ? {
            startTime: historicalWindow.startTime,
            endTime: historicalWindow.endTime,
          }
        : { last: duration }),
    }),
  );

  // Everything below reads the ACTIVE query only — the disabled one sits at isPending:true forever,
  // so mixing them would strand the card on "Loading chart..." (and stall useSettledWindow, which
  // advances to the next requested window only when the current fetch reports it has settled).
  const isPending = useShared ? sitePending : historyPending;
  const isFetching = useShared ? siteFetching : historyFetching;
  const isError = useShared ? siteIsError : historyIsError;
  const queryError = useShared ? siteError : historyError;

  // Report the fetch state back to the committer so it advances to the next requested window only
  // once the current fetch settles (single-flight — see useSettledWindow).
  useEffect(() => {
    reportHistoryFetching(isFetching);
  }, [isFetching, reportHistoryFetching]);

  // The raw OpenNEM-shaped payload `buildChartData` consumes, from whichever query is active. The
  // shared path re-wraps `siteData.rawSeries` as `{ data }` — those are the response's series
  // verbatim (pre-filter, pre-battery-split), so `findSeries`' micromatch on `id` behaves identically
  // to the own-fetch path.
  // Memoized: the shared path allocates a wrapper, and an unstable one here would defeat the
  // referential stability the chartData useMemo below exists to provide (it would recompute, and
  // hand DashboardChart fresh arrays, on EVERY render rather than only on refetch).
  const rawChartSource = useMemo(
    () =>
      useShared
        ? siteData
          ? { data: siteData.rawSeries ?? [] }
          : undefined
        : rawHistory,
    [useShared, siteData, rawHistory],
  );

  const chartData = useMemo<ChartData | null>(
    () =>
      buildChartData(
        rawChartSource,
        period,
        start && end
          ? { start: new Date(start), end: new Date(end) }
          : undefined,
      ),
    [rawChartSource, period, start, end],
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
      period === "D"
        ? 24
        : period === "W"
          ? 24 * 7
          : period === "M"
            ? 24 * 30
            : 24 * 365;
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
