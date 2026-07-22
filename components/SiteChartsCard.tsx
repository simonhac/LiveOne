"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useModalContext } from "@/contexts/ModalContext";
import { siteDataQuery } from "@/lib/queries";
import { type ChartData } from "@/lib/charts/types";
import DashboardChart from "@/components/DashboardChart";
import EnergyTable from "@/components/EnergyTable";
import type { ProcessedSiteData } from "@/lib/site-data-processor";
import EnergyFlowSankey, {
  type SankeyOptions,
  type SankeyNodeTooltip,
  type SankeyNodeTooltipResolver,
  type SankeyLinkTooltipResolver,
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
  reduceLoadProvenance,
  reduceSourceProvenance,
  reduceEdgeProvenance,
  type DailyFlowMatrices,
} from "@/lib/energy-flow-matrix";
import {
  formatKwh,
  formatKgCo2,
  formatGramsPerKwh,
  formatDollars,
  formatCentsPerKwh,
  formatRenewablePct,
} from "@/lib/provenance-format";
import { formatValue, formatFlowMagnitude } from "@/lib/energy-formatting";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { useSettledWindow } from "@/lib/charts/useSettledWindow";
import { useChartFocus, nearestIndex } from "@/lib/charts/ChartFocusContext";
import { formatDateTimeRange } from "@/lib/fe-date-format";
import { formatHoverTimestamp } from "@/lib/charts/scaffold";
import { fromUnixTimestamp } from "@/lib/date-utils";
import { CalendarX2 } from "lucide-react";

interface SiteChartsCardProps {
  systemId: string;
  system?: any; // System object from database
  /**
   * Whether to run the site-history query (the data behind the charts + sankey). The caller drives it
   * from a DATA signal ("this area has loads + sources", from capability chart-eligibility) rather than
   * the vendor type, so the sankey works for any such area. Omitted ⇒ off.
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
  // truth shared with the line chart and every navigator instance on the page. This is the INSTANT
  // desired window (the label follows it immediately); the chart body fetches a settled copy below.
  const {
    period: desiredPeriod,
    start: desiredStart,
    end: desiredEnd,
  } = useTemporalRange({
    timezoneOffsetMin: system?.timezoneOffsetMin ?? 600,
  });
  const desiredWindow = useMemo(
    () => ({ period: desiredPeriod, start: desiredStart, end: desiredEnd }),
    [desiredPeriod, desiredStart, desiredEnd],
  );
  // Single-flight + latest-wins committer: rapid navigation collapses to one in-flight fetch for the
  // window the user lands on (skipped days never requested). The whole chart body reads the committed
  // window, so the chart stays internally consistent while the header label scrubs instantly.
  const [committedWindow, reportHistoryFetching] =
    useSettledWindow(desiredWindow);
  const { period, start, end } = committedWindow;
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
  // Run the site-history query when the area has loads + sources — a data-driven decision the parent
  // supplies (`siteCapable`, from capability chart-eligibility). No vendor branch.
  const runSiteQuery = siteCapable ?? false;
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
  // Report the fetch state back to the committer so it can advance to the next requested window
  // only once the current fetch settles (single-flight — see useSettledWindow).
  useEffect(() => {
    reportHistoryFetching(historyFetching);
  }, [historyFetching, reportHistoryFetching]);

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

  // The Sankey's attributed payload (energy + emissions/renewable/cost legs) now rides the same
  // site-history fetch for every period (see `lib/site-data-processor.ts`) — no separate 30D query.
  // `toLocalYMD` maps a focused instant to the Area-local day string `attributedFlow.days` keys on.
  const flowOffsetMin = system?.timezoneOffsetMin || 0;
  const toLocalYMD = (iso: string) =>
    new Date(new Date(iso).getTime() + flowOffsetMin * 60000)
      .toISOString()
      .slice(0, 10);

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
      {(cardVisible("chart:load") ||
        cardVisible("chart:generation") ||
        cardVisible("sankey")) && (
        <div
          className={`overflow-hidden transition-opacity duration-200 ${
            historyFetching && !historyLoading ? "opacity-60" : ""
          }`}
        >
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
                      loadVisibleSeries.size > 0 ? loadVisibleSeries : undefined
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
                      loadVisibleSeries.size > 0 ? loadVisibleSeries : undefined
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
              // The server-computed ATTRIBUTED payload (energy + emissions/renewable/cost legs) drives
              // BOTH the rendered boxes and the node tooltips (P1 — one matrix for both, never drift).
              // Absent (not-yet-loaded / area with no complete role set / provenance-load failure) →
              // the old energy-only fallback chain, with tooltips degrading to energy-only (P3).
              const attributedFlow = processedHistoryData.attributedFlow;
              const hasAttributed =
                !!attributedFlow && attributedFlow.days.length > 0;

              // 30D hovered day (also the key into `attributedFlow.days`, which is keyed by local YMD
              // for every period — the sub-daily builder shapes its window as a single day entry too).
              const hoveredYMD =
                period === "30D" && focusedTime
                  ? toLocalYMD(focusedTime.toISOString())
                  : null;

              let matrix;
              let focused = false;
              if (period === "30D" && hasAttributed) {
                const dayMatrix = hoveredYMD
                  ? pickDailyFlowMatrix(attributedFlow!, hoveredYMD)
                  : null;
                focused = dayMatrix !== null;
                matrix = dayMatrix ?? sumDailyFlowMatrices(attributedFlow!);
              } else {
                const instant =
                  period !== "30D" && hoveredIndex !== null
                    ? calculateInstantFlowMatrix(
                        processedHistoryData,
                        hoveredIndex,
                      )
                    : null;
                focused = instant !== null;
                matrix =
                  instant ??
                  (hasAttributed && period !== "30D"
                    ? sumDailyFlowMatrices(attributedFlow!)
                    : selectFlowMatrix(processedHistoryData));
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
                      fromUnixTimestamp(cd.timestamps[0].getTime() / 1000, tz),
                      fromUnixTimestamp(
                        cd.timestamps[cd.timestamps.length - 1].getTime() /
                          1000,
                        tz,
                      ),
                      period !== "30D",
                    )
                  : null;

              // The attributed slice the tooltip reduces over — the SAME data the boxes above were
              // built from (30D hovered day → just that day; otherwise the whole payload, which for
              // sub-daily is already a single day entry covering the exact window).
              const daySlice: DailyFlowMatrices | null =
                unit === "kW" || !hasAttributed
                  ? null
                  : period === "30D" && hoveredYMD
                    ? (() => {
                        const d = attributedFlow!.days.find(
                          (x) => x.day === hoveredYMD,
                        );
                        return d
                          ? {
                              sources: attributedFlow!.sources,
                              loads: attributedFlow!.loads,
                              days: [d],
                            }
                          : null;
                      })()
                    : attributedFlow!;

              // Hours the tooltip's "energy" leg is averaged over, for the avg-kW secondary spelling.
              const windowHours =
                period === "30D"
                  ? hoveredYMD
                    ? 24
                    : (attributedFlow?.days.length ?? 30) * 24
                  : cd && cd.timestamps.length > 1
                    ? (cd.timestamps[cd.timestamps.length - 1].getTime() -
                        cd.timestamps[0].getTime()) /
                      3_600_000
                    : period === "7D"
                      ? 24 * 7
                      : 24;

              const buildNodeTooltip: SankeyNodeTooltipResolver = (node) => {
                const avgPower = (energyKwh: number) => {
                  const avgW =
                    windowHours > 0 ? (energyKwh * 1000) / windowHours : 0;
                  const { value, unit: u } = formatValue(avgW, "W");
                  return { value, unit: u };
                };

                if (unit === "kW") {
                  // Focused sub-daily sample: instantaneous power only (no integrals exist at a point).
                  return {
                    name: node.name,
                    variant: "energy",
                    energy: {
                      primary: {
                        value: formatFlowMagnitude(node.total),
                        unit: "kW",
                      },
                    },
                  };
                }
                if (!daySlice) {
                  // Attributed legs unavailable for this matrix — limited (energy-only) tooltip.
                  return {
                    name: node.name,
                    variant: "energy",
                    energy: {
                      primary: { value: formatKwh(node.total), unit: "kWh" },
                      secondary: avgPower(node.total),
                    },
                  };
                }

                const toFull = (summary: {
                  energyKwh: number;
                  costC: number;
                  avgCentsPerKwh: number | null;
                  pctRenewable: number | null;
                  avgGramsPerKwh: number | null;
                  kgCo2: number;
                  pctEstimated: number;
                }): SankeyNodeTooltip => ({
                  name: node.name,
                  variant: "full",
                  energy: {
                    primary: {
                      value: formatKwh(summary.energyKwh),
                      unit: "kWh",
                    },
                    secondary: avgPower(summary.energyKwh),
                  },
                  emissions: {
                    primary: { value: formatKgCo2(summary.kgCo2), unit: "kg" },
                    secondary: {
                      value: formatGramsPerKwh(summary.avgGramsPerKwh),
                      unit: "g/kWh",
                    },
                  },
                  cost: {
                    // "$" is baked into the value — no unit beneath.
                    primary: { value: formatDollars(summary.costC) },
                    secondary: {
                      value: formatCentsPerKwh(summary.avgCentsPerKwh),
                      unit: "c/kWh",
                    },
                  },
                  // "%" is baked into the value — no unit beneath.
                  renewable: {
                    primary: {
                      value: formatRenewablePct(summary.pctRenewable),
                    },
                  },
                  estimatedPct: summary.pctEstimated,
                });

                if (node.id === "bidi.battery") {
                  // Battery-middle's storage node: BOTH panels simultaneously — load-mode (charge) on
                  // the left, source-mode (discharge) on the right.
                  const charge = reduceLoadProvenance(daySlice, "load.battery");
                  const discharge = reduceSourceProvenance(
                    daySlice,
                    "source.battery",
                  );
                  if (!charge && !discharge) return null;
                  const empty: SankeyNodeTooltip = {
                    name: node.name,
                    variant: "energy",
                    energy: { primary: { value: "—" } },
                  };
                  return {
                    left: charge ? toFull(charge) : empty,
                    right: discharge ? toFull(discharge) : empty,
                  };
                }

                if (!node.id) return null;
                const summary =
                  node.side === "load"
                    ? reduceLoadProvenance(daySlice, node.id)
                    : reduceSourceProvenance(daySlice, node.id, {
                        combineSolar: sankeyOptions.combineSolar,
                      });
                return summary ? toFull(summary) : null;
              };

              // Per-link (spline) tooltip — mirrors buildNodeTooltip's degradation ladder so link and
              // node numbers can't drift: focused sub-daily sample → power only; no attributed legs →
              // energy only; otherwise the exact per-edge reduction over the SAME `daySlice`. The energy
              // line always uses `link.value` (matches the ribbon width); only the detail line comes from
              // the reduction.
              const buildLinkTooltip: SankeyLinkTooltipResolver = (link) => {
                if (unit === "kW") {
                  return {
                    energy: formatFlowMagnitude(link.value),
                    energyUnit: "kW",
                  };
                }
                const base = {
                  energy: formatKwh(link.value),
                  energyUnit: "kWh",
                };
                if (!daySlice) return base;
                // Battery-middle relocates the battery to a synthetic middle node; map it back to the
                // raw provenance ids (charge = source→load.battery, discharge = source.battery→load).
                const sourceId =
                  link.source.id === "bidi.battery"
                    ? "source.battery"
                    : link.source.id;
                const loadId =
                  link.target.id === "bidi.battery"
                    ? "load.battery"
                    : link.target.id;
                if (!sourceId || !loadId) return base;
                const edge = reduceEdgeProvenance(daySlice, sourceId, loadId, {
                  combineSolar: sankeyOptions.combineSolar,
                });
                if (!edge) return base;
                return {
                  ...base,
                  emissions: `${formatKgCo2(edge.kgCo2)} kg`,
                  cost: formatDollars(edge.costC),
                  // The link tooltip prints this bare (no caption), so self-label it "RE"
                  // to distinguish it from the emissions/cost figures beside it. Only when a
                  // value exists — an unknown stays "—", not "— RE". (The node tooltip already
                  // has a "renewable" caption, so it keeps the bare `formatRenewablePct`.)
                  renewable:
                    edge.pctRenewable != null
                      ? `${formatRenewablePct(edge.pctRenewable)} RE`
                      : formatRenewablePct(edge.pctRenewable),
                };
              };

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
                      nodeTooltip={buildNodeTooltip}
                      linkTooltip={buildLinkTooltip}
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
