"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useModalContext } from "@/contexts/ModalContext";
import { siteDataQuery, flowMatrixQuery } from "@/lib/queries";
import { type ChartData } from "@/lib/charts/types";
import DashboardChart from "@/components/DashboardChart";
import EnergyTable from "@/components/EnergyTable";
import type { ProcessedSiteData } from "@/lib/site-data-processor";
import EnergyFlowSankey, {
  type SankeyOptions,
  DEFAULT_SANKEY_OPTIONS,
} from "@/components/EnergyFlowSankey";
import FlowsSettingsMenu, {
  type SankeyCapabilities,
} from "@/components/FlowsSettingsMenu";
import {
  selectFlowMatrix,
  calculateInstantFlowMatrix,
  sumDailyFlowMatrices,
  pickDailyFlowMatrix,
  combineSolarSources,
} from "@/lib/energy-flow-matrix";
import TemporalNavigator from "@/components/TemporalNavigator";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { useChartFocus, nearestIndex } from "@/lib/charts/ChartFocusContext";
import { formatDateTimeRange } from "@/lib/fe-date-format";
import { formatHoverTimestamp } from "@/lib/charts/scaffold";
import { fromUnixTimestamp } from "@/lib/date-utils";
import { CalendarX2 } from "lucide-react";

interface SiteChartsCardProps {
  systemId: string;
  system?: any; // System object from database
  /**
   * Whether to run the site-history query (the data behind the charts + sankey). Lets the caller drive
   * it from a DATA signal ("this area has loads + sources") rather than the vendor type, so the sankey
   * works for any such area. Omitted ⇒ falls back to the vendor check (mondo/composite), preserving the
   * legacy per-system page.
   */
  siteCapable?: boolean;
  cardVisible: (idOrType: string) => boolean;
  /**
   * Reports the site-history fetch state back to the parent so it can render the
   * "unconfigured composite" warning in its original position (above the tiles grid).
   * `true` once the fetch has settled with no load/generation data; `false` while
   * loading or once data is present. The site-data query itself lives here.
   */
  onHistoryEmptyChange?: (empty: boolean) => void;
  /**
   * Opaque key the Sankey display options are persisted under (localStorage `sankey.options:<key>`).
   * The dashboard composes it as `sankeyId:areaId:dashboardId` so each sankey remembers independently.
   * Omitted (e.g. legacy per-system page) ⇒ falls back to `systemId`.
   */
  sankeyOptionsKey?: string;
}

const SANKEY_OPTIONS_STORAGE_PREFIX = "sankey.options:";

/** Defensive parse of persisted Sankey options — unknown/malformed fields fall back to the default. */
function coerceSankeyOptions(raw: unknown): SankeyOptions {
  const next = { ...DEFAULT_SANKEY_OPTIONS };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.combineSolar === "boolean") next.combineSolar = r.combineSolar;
    if (typeof r.batteryMiddle === "boolean")
      next.batteryMiddle = r.batteryMiddle;
  }
  return next;
}

interface StackedChartProps {
  mode: "load" | "generation";
  period: "1D" | "7D" | "30D";
  /** Pre-processed data from the parent (null = no data / still loading). */
  data: ChartData | null;
  /** External loading state from the parent. */
  isLoading?: boolean;
  /** External hover index to sync with the other chart. */
  hoveredIndex?: number | null;
  /** Callback when this chart's hover index changes. */
  onHoverIndexChange?: (index: number | null) => void;
  /** Control which series are visible. */
  visibleSeries?: Set<string>;
  className?: string;
}

/**
 * Presentational stacked-area (or 30D bar) chart for the site load/generation halves.
 * Inlined from the former SitePowerChart wrapper — the parent (SiteChartsCard) owns the
 * fetch, period, URL nav, cross-chart hover arbitration, and series-visibility state.
 */
function StackedChart({
  mode,
  period,
  data,
  isLoading,
  hoveredIndex: externalHoveredIndex,
  onHoverIndexChange,
  visibleSeries,
  className = "",
}: StackedChartProps) {
  const [loading, setLoading] = useState(true);
  const [showSpinner, setShowSpinner] = useState(false);
  const [hoveredTimestamp, setHoveredTimestamp] = useState<Date | null>(null);
  const chartRef = useRef<any>(null);

  // Compute effective visibility - if empty/undefined, show all series
  const effectiveVisibleSeries = useMemo(() => {
    if ((!visibleSeries || visibleSeries.size === 0) && data) {
      return new Set(data.series.map((s) => s.id));
    }
    return visibleSeries ?? new Set<string>();
  }, [visibleSeries, data]);

  // Sync external hovered index with internal timestamp
  useEffect(() => {
    if (externalHoveredIndex !== undefined && data) {
      if (
        externalHoveredIndex !== null &&
        data.timestamps[externalHoveredIndex]
      ) {
        setHoveredTimestamp(data.timestamps[externalHoveredIndex]);
      } else {
        setHoveredTimestamp(null);
      }
    }
  }, [externalHoveredIndex, data]);

  const lastHoverIndexRef = useRef<number | null>(null);

  const handleHover = useCallback(
    (_event: any, activeElements: any[], _chart: any) => {
      if (!data) return;

      if (activeElements && activeElements.length > 0) {
        const dataIndex = activeElements[0].index;

        // Only update if index actually changed (reduces jitter)
        if (lastHoverIndexRef.current !== dataIndex) {
          lastHoverIndexRef.current = dataIndex;
          const timestamp = data.timestamps[dataIndex];
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
    [data, onHoverIndexChange],
  );

  const { now, windowStart } = useMemo(() => {
    // When data is available, use its actual timestamp range
    // This ensures historical data is displayed correctly
    if (data && data.timestamps && data.timestamps.length > 0) {
      const timestamps = data.timestamps;
      return {
        windowStart: timestamps[0],
        now: timestamps[timestamps.length - 1],
      };
    }

    // Otherwise, use current time window (for initial render or live mode)
    const now = new Date();
    let windowHours: number;
    if (period === "1D") {
      windowHours = 24;
    } else if (period === "7D") {
      windowHours = 24 * 7;
    } else {
      windowHours = 24 * 30;
    }
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    return { now, windowStart };
  }, [period, data]);

  // Track loading state from the parent-provided data/isLoading props
  useEffect(() => {
    if (data === null) {
      // If data is null, check if parent is still loading
      if (isLoading) {
        // Parent is still loading, keep spinner
        setLoading(true);
      } else {
        // Parent finished loading but data is null (no data available)
        setLoading(false);
      }
    } else {
      // We have actual data
      setLoading(false);
    }
  }, [data, isLoading]);

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

    if (!data) {
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
      <DashboardChart
        variant="stacked-areas"
        chartData={data}
        effectiveVisibleSeries={effectiveVisibleSeries}
        mode={mode}
        hoveredTimestamp={hoveredTimestamp}
        timeRange={period}
        now={now}
        windowStart={windowStart}
        onHover={handleHover}
        chartRef={chartRef}
        className="flex-1 min-h-0 w-full overflow-hidden"
        onMouseLeave={handleMouseLeave}
      />
    );
  };

  return (
    <div
      className={`flex flex-col site-power-chart-container ${className}`}
      onMouseLeave={handleMouseLeave}
    >
      {renderChartContent()}
    </div>
  );
}

export default function SiteChartsCard({
  systemId,
  system,
  siteCapable,
  cardVisible,
  onHistoryEmptyChange,
  sankeyOptionsKey,
}: SiteChartsCardProps) {
  // Get modal context to pause polling when modals are open
  const { isAnyModalOpen } = useModalContext();

  // Shared temporal-navigator state (period + historical window) read from the URL — one source of
  // truth shared with the line chart and every navigator instance on the page.
  const { period, start, end } = useTemporalRange({
    timezoneOffsetMin: system?.timezoneOffsetMin ?? 600,
  });
  // Shared focus instant for this chart cluster — the load + generation charts publish their hover
  // here, and the red focus line / EnergyTable highlight / Sankey all read it back, so they also
  // follow focus set by the sibling line chart.
  const { focusedTime, setFocusedTime } = useChartFocus();

  const [loadChartData, setLoadChartData] = useState<ChartData | null>(null);
  const [generationChartData, setGenerationChartData] =
    useState<ChartData | null>(null);
  const [activeChart, setActiveChart] = useState<"load" | "generation" | null>(
    null,
  ); // Track which chart was last touched
  const [loadVisibleSeries, setLoadVisibleSeries] = useState<Set<string>>(
    new Set(),
  );
  const [generationVisibleSeries, setGenerationVisibleSeries] = useState<
    Set<string>
  >(new Set());

  // Sankey display options ("combine solar" / "battery in the middle"), persisted per sankey in
  // localStorage under `sankey.options:<key>` (composite `sankeyId:areaId:dashboardId`, falling back to
  // the systemId handle). Loaded in a mount/key-change effect so the first paint matches SSR (no
  // hydration mismatch) and switching dashboards/areas swaps the remembered options.
  const sankeyStorageKey = `${SANKEY_OPTIONS_STORAGE_PREFIX}${sankeyOptionsKey ?? systemId}`;
  const [sankeyOptions, setSankeyOptions] = useState<SankeyOptions>(
    DEFAULT_SANKEY_OPTIONS,
  );
  useEffect(() => {
    try {
      const stored = localStorage.getItem(sankeyStorageKey);
      setSankeyOptions(
        stored
          ? coerceSankeyOptions(JSON.parse(stored))
          : DEFAULT_SANKEY_OPTIONS,
      );
    } catch {
      setSankeyOptions(DEFAULT_SANKEY_OPTIONS);
    }
  }, [sankeyStorageKey]);
  const persistSankeyOptions = useCallback(
    (next: SankeyOptions) => {
      setSankeyOptions(next);
      try {
        localStorage.setItem(sankeyStorageKey, JSON.stringify(next));
      } catch {
        // ignore storage failures (private mode, quota, disabled storage)
      }
    },
    [sankeyStorageKey],
  );

  // Mondo/composite "site" history via React Query. A live window refetches on the 5-min
  // boundary; an explicit historical window (prev/next navigation) is settled (no polling).
  // Fetch + process + windowing happen inside the query factory, so `processedHistoryData`
  // is referentially stable between renders and slides forward only on each refetch.
  // Run the site-history query when the area has loads + sources. Caller-supplied `siteCapable` (data
  // driven) wins; otherwise fall back to the vendor check, so the legacy per-system page is unchanged.
  const isSiteVendor =
    system?.vendorType === "mondo" || system?.vendorType === "composite";
  const runSiteQuery = siteCapable ?? isSiteVendor;
  const {
    data: siteData,
    isLoading: historyLoading,
    isFetching: historyFetching,
  } = useQuery(
    siteDataQuery({
      systemId: systemId ?? "",
      period,
      start,
      end,
      timezoneOffsetMin: system?.timezoneOffsetMin ?? 0,
      paused: isAnyModalOpen,
      enabled: runSiteQuery && !!systemId,
    }),
  );
  const processedHistoryData = useMemo<ProcessedSiteData>(
    () => siteData ?? { load: null, generation: null },
    [siteData],
  );

  // Report the "no chart data" state to the parent so it can render the unconfigured-composite
  // warning above the tiles grid (its original position). Matches the prior inline condition:
  // settled (not loading) with neither load nor generation present.
  useEffect(() => {
    onHistoryEmptyChange?.(
      !historyLoading &&
        !processedHistoryData.load &&
        !processedHistoryData.generation,
    );
  }, [
    historyLoading,
    processedHistoryData.load,
    processedHistoryData.generation,
    onHistoryEmptyChange,
  ]);

  // Mirror the latest site fetch into the chart-data state the EnergyTable reads.
  useEffect(() => {
    if (siteData) {
      setLoadChartData(siteData.load);
      setGenerationChartData(siteData.generation);
    }
  }, [siteData]);

  // Long-range Sankey from Postgres (point_readings_flow_1d), 30D only; a dependent query keyed on
  // the site fetch's request window. When not yet loaded / errored / not materialized, pgDaily stays
  // null and the render falls back to the client-side window calc.
  const flowOffsetMin = system?.timezoneOffsetMin || 0;
  const toLocalYMD = (iso: string) =>
    new Date(new Date(iso).getTime() + flowOffsetMin * 60000)
      .toISOString()
      .slice(0, 10);
  const flowEnabled =
    period === "30D" &&
    !!systemId &&
    !!processedHistoryData.requestStart &&
    !!processedHistoryData.requestEnd;
  const { data: pgFlowMatrixData } = useQuery(
    flowMatrixQuery({
      systemId: systemId ?? "",
      startYMD: processedHistoryData.requestStart
        ? toLocalYMD(processedHistoryData.requestStart)
        : "",
      endYMD: processedHistoryData.requestEnd
        ? toLocalYMD(processedHistoryData.requestEnd)
        : "",
      timezoneOffsetMin: flowOffsetMin,
      enabled: flowEnabled,
    }),
  );
  // Raw per-day flow matrices (30D); the render sums them for the window or picks the hovered day.
  const pgDaily = flowEnabled ? (pgFlowMatrixData ?? null) : null;

  // Prev/next navigation + keyboard handling now live in the shared TemporalNavigator (driven by the
  // URL via useTemporalRange) — rendered in this card's header below.

  // Hover handlers that track which chart is active on touch devices. Each reports a row index into
  // its own chart's data; we resolve it to a TIMESTAMP and publish that to the shared focus (so the
  // line chart, which has a different grid, can map it back to its own nearest index).
  const handleLoadHoverIndexChange = useCallback(
    (index: number | null) => {
      const ts =
        index !== null
          ? (processedHistoryData.load?.timestamps[index] ?? null)
          : null;
      // On touch devices, only accept updates from the active chart
      if ("ontouchstart" in window) {
        if (index !== null) {
          // New touch - this chart becomes active
          setActiveChart("load");
          setFocusedTime(ts);
        } else if (activeChart === "load") {
          // Only clear if this was the active chart
          setFocusedTime(null);
        }
        // Ignore clear events from non-active charts
      } else {
        // On desktop, accept all updates (normal mouse behavior)
        setFocusedTime(ts);
      }
    },
    [activeChart, processedHistoryData.load, setFocusedTime],
  );

  const handleGenerationHoverIndexChange = useCallback(
    (index: number | null) => {
      const ts =
        index !== null
          ? (processedHistoryData.generation?.timestamps[index] ?? null)
          : null;
      // On touch devices, only accept updates from the active chart
      if ("ontouchstart" in window) {
        if (index !== null) {
          // New touch - this chart becomes active
          setActiveChart("generation");
          setFocusedTime(ts);
        } else if (activeChart === "generation") {
          // Only clear if this was the active chart
          setFocusedTime(null);
        }
        // Ignore clear events from non-active charts
      } else {
        // On desktop, accept all updates (normal mouse behavior)
        setFocusedTime(ts);
      }
    },
    [activeChart, processedHistoryData.generation, setFocusedTime],
  );

  // The shared focus instant resolved to a row index on the site charts' grid (load + generation
  // share one timestamp axis). Drives the red hover line, the EnergyTable highlight, and the
  // focused-point Sankey below.
  const hoveredIndex = nearestIndex(
    processedHistoryData.load?.timestamps ??
      processedHistoryData.generation?.timestamps,
    focusedTime,
  );

  // Global touch handler to clear hover when touching outside charts
  useEffect(() => {
    const handleTouchOutside = (e: TouchEvent) => {
      // Check if the touch target is outside both chart containers
      const target = e.target as HTMLElement;
      const isInChart = target.closest(".site-power-chart-container");

      if (!isInChart) {
        setActiveChart(null);
        setFocusedTime(null);
      }
    };

    // Only add listener on touch devices
    if ("ontouchstart" in window) {
      document.addEventListener("touchstart", handleTouchOutside);
      return () =>
        document.removeEventListener("touchstart", handleTouchOutside);
    }
  }, []);

  // Handle series visibility toggle with special logic
  const handleLoadSeriesToggle = (seriesId: string, shiftKey: boolean) => {
    const allSeriesIds = loadChartData?.series.map((s) => s.id) ?? [];

    if (shiftKey) {
      // Shift-click: show only this series
      setLoadVisibleSeries(new Set([seriesId]));
    } else {
      // Regular click: toggle visibility
      const newVisible = new Set(loadVisibleSeries);

      // If series is not in the set or set is empty, we're starting fresh - add all series first
      if (newVisible.size === 0) {
        allSeriesIds.forEach((id) => newVisible.add(id));
      }

      if (newVisible.has(seriesId)) {
        // Check if this is the only visible series
        if (newVisible.size === 1) {
          // Show all series instead of hiding the last one
          allSeriesIds.forEach((id) => newVisible.add(id));
        } else {
          newVisible.delete(seriesId);
        }
      } else {
        newVisible.add(seriesId);
      }

      setLoadVisibleSeries(newVisible);
    }
  };

  const handleGenerationSeriesToggle = (
    seriesId: string,
    shiftKey: boolean,
  ) => {
    const allSeriesIds = generationChartData?.series.map((s) => s.id) ?? [];

    if (shiftKey) {
      // Shift-click: show only this series
      setGenerationVisibleSeries(new Set([seriesId]));
    } else {
      // Regular click: toggle visibility
      const newVisible = new Set(generationVisibleSeries);

      // If series is not in the set or set is empty, we're starting fresh - add all series first
      if (newVisible.size === 0) {
        allSeriesIds.forEach((id) => newVisible.add(id));
      }

      if (newVisible.has(seriesId)) {
        // Check if this is the only visible series
        if (newVisible.size === 1) {
          // Show all series instead of hiding the last one
          allSeriesIds.forEach((id) => newVisible.add(id));
        } else {
          newVisible.delete(seriesId);
        }
      } else {
        newVisible.add(seriesId);
      }

      setGenerationVisibleSeries(newVisible);
    }
  };

  return (
    <>
      {/* Charts - For mondo/composite systems, show charts with tables in single container */}
      {/* Hide entire container for unconfigured composite systems */}
      {(cardVisible("chart:load") ||
        cardVisible("chart:generation") ||
        cardVisible("sankey")) &&
        (historyLoading ||
          processedHistoryData.load ||
          processedHistoryData.generation ||
          system?.vendorType !== "composite") && (
          <div
            className={`overflow-hidden transition-opacity duration-200 ${
              historyFetching && !historyLoading ? "opacity-60" : ""
            }`}
          >
            {/* Shared header with date/time and period switcher */}
            <div className="px-2 sm:px-4 pt-2 sm:pt-4 pb-1 sm:pb-2">
              <TemporalNavigator
                timezoneOffsetMin={system?.timezoneOffsetMin ?? 600}
                loading={historyLoading}
              />
            </div>

            {/* Loads Chart with Table */}
            {cardVisible("chart:load") && (
              <div className="px-2 sm:px-4 pt-1 sm:pt-2 pb-2 sm:pb-4">
                <div className="flex flex-col md:flex-row md:gap-4">
                  <div className="flex-1 min-w-0">
                    <StackedChart
                      mode="load"
                      className="h-full min-h-[375px]"
                      period={period}
                      onHoverIndexChange={handleLoadHoverIndexChange}
                      hoveredIndex={hoveredIndex}
                      visibleSeries={
                        loadVisibleSeries.size > 0
                          ? loadVisibleSeries
                          : undefined
                      }
                      data={processedHistoryData.load}
                      isLoading={historyLoading}
                    />
                  </div>
                  <div className="w-full md:w-64 mt-4 md:mt-0 flex-shrink-0">
                    <EnergyTable
                      chartData={loadChartData}
                      mode="load"
                      hoveredIndex={hoveredIndex}
                      className="h-full"
                      visibleSeries={
                        loadVisibleSeries.size > 0
                          ? loadVisibleSeries
                          : undefined
                      }
                      onSeriesToggle={handleLoadSeriesToggle}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Generation Chart with Table */}
            {cardVisible("chart:generation") && (
              <div className="p-2 sm:p-4">
                <div className="flex flex-col md:flex-row md:gap-4">
                  <div className="flex-1 min-w-0">
                    <StackedChart
                      mode="generation"
                      className="h-full min-h-[375px]"
                      period={period}
                      onHoverIndexChange={handleGenerationHoverIndexChange}
                      hoveredIndex={hoveredIndex}
                      visibleSeries={
                        generationVisibleSeries.size > 0
                          ? generationVisibleSeries
                          : undefined
                      }
                      data={processedHistoryData.generation}
                      isLoading={historyLoading}
                    />
                  </div>
                  <div className="w-full md:w-64 mt-4 md:mt-0 flex-shrink-0">
                    <EnergyTable
                      chartData={generationChartData}
                      mode="generation"
                      hoveredIndex={hoveredIndex}
                      className="h-full"
                      visibleSeries={
                        generationVisibleSeries.size > 0
                          ? generationVisibleSeries
                          : undefined
                      }
                      onSeriesToggle={handleGenerationSeriesToggle}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Energy Flow Sankey Diagram */}
            {cardVisible("sankey") &&
              processedHistoryData.generation &&
              processedHistoryData.load &&
              (() => {
                // 30D: the Sankey is REAL per-day energy from flow_1d — sum the window's days when
                // nothing is hovered, or pick the hovered day's matrix (kWh either way). Sub-daily
                // (1D/7D) shows the instantaneous-POWER (kW) snapshot on hover, else the window
                // matrix via selectFlowMatrix. `focused` drives the kW/kWh label below.
                let matrix;
                let focused = false;
                if (period === "30D" && pgDaily && pgDaily.days.length > 0) {
                  const hoveredYMD = focusedTime
                    ? toLocalYMD(focusedTime.toISOString())
                    : null;
                  const dayMatrix = hoveredYMD
                    ? pickDailyFlowMatrix(pgDaily, hoveredYMD)
                    : null;
                  focused = dayMatrix !== null;
                  matrix = dayMatrix ?? sumDailyFlowMatrices(pgDaily);
                } else {
                  const instant =
                    period !== "30D" && hoveredIndex !== null
                      ? calculateInstantFlowMatrix(
                          processedHistoryData,
                          hoveredIndex,
                        )
                      : null;
                  focused = instant !== null;
                  matrix = instant ?? selectFlowMatrix(processedHistoryData);
                }
                if (!matrix) return null;
                // Capabilities from the RAW matrix node set (hover-invariant; computed BEFORE the
                // combine-solar transform so an enabled toggle doesn't read as "disabled").
                const solarCount = matrix.sources.filter(
                  (s) =>
                    s.id === "source.solar" || s.id.startsWith("source.solar."),
                ).length;
                const sankeyCapabilities: SankeyCapabilities = {
                  canCombineSolar: solarCount >= 2,
                  hasBattery:
                    matrix.sources.some((s) => s.id === "source.battery") ||
                    matrix.loads.some((l) => l.id === "load.battery"),
                };
                const displayMatrix = sankeyOptions.combineSolar
                  ? combineSolarSources(matrix)
                  : matrix;
                const unit = focused && period !== "30D" ? "kW" : "kWh";
                const tz = system?.timezoneOffsetMin;
                // Label: the focused instant when hovering, else the window the sankey integrates over
                // (a TIME range for 1D/7D, a DATE range for 30D).
                const cd =
                  processedHistoryData.load ?? processedHistoryData.generation;
                const label = focusedTime
                  ? formatHoverTimestamp(focusedTime, period, false)
                  : cd && cd.timestamps.length > 0 && tz != null
                    ? formatDateTimeRange(
                        fromUnixTimestamp(
                          cd.timestamps[0].getTime() / 1000,
                          tz,
                        ),
                        fromUnixTimestamp(
                          cd.timestamps[cd.timestamps.length - 1].getTime() /
                            1000,
                          tz,
                        ),
                        period !== "30D",
                      )
                    : null;
                return (
                  <div className="sm:p-4">
                    <div className="mb-2 flex items-center justify-between px-2 sm:px-0">
                      <h3 className="text-base font-semibold text-gray-300">
                        Flows
                      </h3>
                      <FlowsSettingsMenu
                        options={sankeyOptions}
                        capabilities={sankeyCapabilities}
                        onChange={persistSankeyOptions}
                      />
                    </div>
                    <div className="flex justify-center">
                      <EnergyFlowSankey
                        matrix={displayMatrix}
                        unit={unit}
                        layout={
                          sankeyOptions.batteryMiddle
                            ? "battery-middle"
                            : "columns"
                        }
                        width={600}
                        height={680}
                      />
                    </div>
                    {label && (
                      <div className="mt-1 text-center text-xs text-gray-500">
                        {label}
                      </div>
                    )}
                  </div>
                );
              })()}
          </div>
        )}
    </>
  );
}
