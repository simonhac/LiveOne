"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useModalContext } from "@/contexts/ModalContext";
import { siteDataQuery, flowMatrixQuery } from "@/lib/queries";
import SitePowerChart, { type ChartData } from "@/components/SitePowerChart";
import EnergyTable from "@/components/EnergyTable";
import type { ProcessedSiteData } from "@/lib/site-data-processor";
import EnergyFlowSankey from "@/components/EnergyFlowSankey";
import { calculateEnergyFlowMatrix } from "@/lib/energy-flow-matrix";
import PeriodSwitcher from "@/components/PeriodSwitcher";
import { formatDateTimeRange } from "@/lib/fe-date-format";
import { fromUnixTimestamp } from "@/lib/date-utils";
import {
  encodeUrlDate,
  decodeUrlDate,
  encodeUrlOffset,
  decodeUrlOffset,
} from "@/lib/url-date";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface SiteChartsCardProps {
  systemId: string;
  system?: any; // System object from database
  /** When true, the long-range (30D) Sankey is served from PG (FLOW_MATRIX_SERVE_FROM_PG). */
  serveFlowFromPg: boolean;
  cardVisible: (idOrType: string) => boolean;
  /**
   * Reports the site-history fetch state back to the parent so it can render the
   * "unconfigured composite" warning in its original position (above the tiles grid).
   * `true` once the fetch has settled with no load/generation data; `false` while
   * loading or once data is present. The site-data query itself lives here.
   */
  onHistoryEmptyChange?: (empty: boolean) => void;
}

// Helper function to get period duration in milliseconds
const getPeriodDuration = (period: "1D" | "7D" | "30D"): number => {
  if (period === "1D") return 24 * 60 * 60 * 1000;
  if (period === "7D") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
};

// Helper function to get data interval in minutes for a given period
const getPeriodIntervalMinutes = (period: "1D" | "7D" | "30D"): number => {
  if (period === "1D") return 5;
  if (period === "7D") return 30;
  return 24 * 60; // 1 day
};

export default function SiteChartsCard({
  systemId,
  system,
  serveFlowFromPg,
  cardVisible,
  onHistoryEmptyChange,
}: SiteChartsCardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Get modal context to pause polling when modals are open
  const { isAnyModalOpen } = useModalContext();

  const [sitePeriod, setSitePeriod] = useState<"1D" | "7D" | "30D">(() => {
    // Initialize from URL params if present, otherwise default to "1D"
    const periodParam = searchParams.get("period");
    if (periodParam === "1D" || periodParam === "7D" || periodParam === "30D") {
      return periodParam;
    }
    return "1D";
  });
  const [historyTimeRange, setHistoryTimeRange] = useState<{
    start?: string;
    end?: string;
  }>(() => {
    // Initialize from URL params if present
    const startEncoded = searchParams.get("start");
    const endEncoded = searchParams.get("end");
    const offsetEncoded = searchParams.get("offset");
    const periodParam = searchParams.get("period");

    if (!periodParam) {
      return {};
    }

    const period =
      periodParam === "1D" || periodParam === "7D" || periodParam === "30D"
        ? periodParam
        : "1D";

    // For 30D (day-based), use offset=0 (no timezone conversion)
    // For other periods, offset is required
    const offsetMin =
      period === "30D"
        ? 0
        : offsetEncoded
          ? decodeUrlOffset(offsetEncoded)
          : null;

    if (offsetMin === null) {
      return {}; // offset is required for non-day-based periods
    }

    const periodDuration = getPeriodDuration(period);

    // Case 1: Both start and end provided
    if (startEncoded && endEncoded) {
      const start = decodeUrlDate(startEncoded, offsetMin);
      const end = decodeUrlDate(endEncoded, offsetMin);

      // Validate that start + period == end
      const expectedEnd = new Date(new Date(start).getTime() + periodDuration);
      const actualEnd = new Date(end);

      if (expectedEnd.getTime() !== actualEnd.getTime()) {
        console.error("URL parameters don't agree: start + period != end");
        // Fall back to using start + period
        return {
          start,
          end: expectedEnd.toISOString(),
        };
      }

      return { start, end };
    }

    // Case 2: Only start provided - calculate end
    if (startEncoded) {
      const start = decodeUrlDate(startEncoded, offsetMin);
      const end = new Date(new Date(start).getTime() + periodDuration);
      return { start, end: end.toISOString() };
    }

    // Case 3: Only end provided - calculate start
    if (endEncoded) {
      const end = decodeUrlDate(endEncoded, offsetMin);
      const start = new Date(new Date(end).getTime() - periodDuration);
      return { start: start.toISOString(), end };
    }

    return {};
  });

  // Derive whether we're in historical navigation mode (vs live mode)
  const isHistoricalMode = useMemo(
    () => !!(historyTimeRange.start || historyTimeRange.end),
    [historyTimeRange],
  );

  const [loadChartData, setLoadChartData] = useState<ChartData | null>(null);
  const [generationChartData, setGenerationChartData] =
    useState<ChartData | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null); // Single hover index for both charts
  const [activeChart, setActiveChart] = useState<"load" | "generation" | null>(
    null,
  ); // Track which chart was last touched
  const [loadVisibleSeries, setLoadVisibleSeries] = useState<Set<string>>(
    new Set(),
  );
  const [generationVisibleSeries, setGenerationVisibleSeries] = useState<
    Set<string>
  >(new Set());

  // Mondo/composite "site" history via React Query. A live window refetches on the 5-min
  // boundary; an explicit historical window (prev/next navigation) is settled (no polling).
  // Fetch + process + windowing happen inside the query factory, so `processedHistoryData`
  // is referentially stable between renders and slides forward only on each refetch.
  const isSiteVendor =
    system?.vendorType === "mondo" || system?.vendorType === "composite";
  const { data: siteData, isLoading: historyLoading } = useQuery(
    siteDataQuery({
      systemId: systemId ?? "",
      period: sitePeriod,
      start: historyTimeRange.start,
      end: historyTimeRange.end,
      timezoneOffsetMin: system?.timezoneOffsetMin ?? 0,
      paused: isAnyModalOpen,
      enabled: isSiteVendor && !!systemId,
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

  // Mirror the latest site fetch into the chart-data state the EnergyTable reads
  // (SitePowerChart's onDataChange keeps these in sync as it renders, too).
  useEffect(() => {
    if (siteData) {
      setLoadChartData(siteData.load);
      setGenerationChartData(siteData.generation);
    }
  }, [siteData]);

  // In historical mode, normalize the window to the server-aligned request window so prev/next
  // navigation steps from the actual fetched range. Guarded by equality so it converges.
  useEffect(() => {
    if (!siteData || !isHistoricalMode) return;
    const { requestStart, requestEnd } = siteData;
    if (!requestStart || !requestEnd) return;
    setHistoryTimeRange((prev) =>
      prev.start === requestStart && prev.end === requestEnd
        ? prev
        : { start: requestStart, end: requestEnd },
    );
  }, [siteData, isHistoricalMode]);

  // Long-range Sankey from Postgres (point_readings_flow_1d), gated by FLOW_MATRIX_SERVE_FROM_PG.
  // 30D only; a dependent query keyed on the site fetch's request window. When disabled / not yet
  // loaded / errored, pgFlowMatrix stays null and the render falls back to the client-side calc.
  const flowOffsetMin = system?.timezoneOffsetMin || 0;
  const toLocalYMD = (iso: string) =>
    new Date(new Date(iso).getTime() + flowOffsetMin * 60000)
      .toISOString()
      .slice(0, 10);
  const flowEnabled =
    serveFlowFromPg &&
    sitePeriod === "30D" &&
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
  const pgFlowMatrix = flowEnabled ? (pgFlowMatrixData ?? null) : null;

  // Ensure period is always in the URL
  useEffect(() => {
    const periodParam = searchParams.get("period");
    if (!periodParam) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("period", sitePeriod);
      router.push(`?${params.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only on mount - intentionally ignoring dependencies

  // Navigation handlers for prev/next buttons
  const handlePageNewer = useCallback(() => {
    if (historyTimeRange.start && historyTimeRange.end && system) {
      // Go forward in time by one period
      const currentStart = new Date(historyTimeRange.start);
      const currentEnd = new Date(historyTimeRange.end);
      const duration = currentEnd.getTime() - currentStart.getTime();

      const newStart = new Date(currentEnd.getTime());
      const newEnd = new Date(currentEnd.getTime() + duration);

      // Check if the new end would be past current time or very close to it
      // If we're within one interval of "now", revert to live mode
      const now = new Date();
      const intervalMs = getPeriodIntervalMinutes(sitePeriod) * 60 * 1000;
      if (newEnd.getTime() > now.getTime() - intervalMs) {
        // Revert to live mode - clear start/end/offset from URL
        setHistoryTimeRange({});

        const params = new URLSearchParams(searchParams.toString());
        params.delete("start");
        params.delete("end");
        params.delete("offset");
        router.push(`?${params.toString()}`, { scroll: false });
        return;
      }

      const newStartISO = newStart.toISOString();
      const newEndISO = newEnd.toISOString();

      setHistoryTimeRange({
        start: newStartISO,
        end: newEndISO,
      });

      // Update URL with only start (period is already in URL, end can be calculated)
      const offsetMin = system.timezoneOffsetMin ?? 600;
      const params = new URLSearchParams(searchParams.toString());
      const isDateOnly = sitePeriod === "30D";
      params.set("start", encodeUrlDate(newStartISO, offsetMin, isDateOnly));
      params.delete("end"); // Remove end - it's redundant with start + period
      // Only include offset for time-based periods (1D, 7D)
      if (isDateOnly) {
        params.delete("offset");
      } else {
        params.set("offset", encodeUrlOffset(offsetMin));
      }
      router.push(`?${params.toString()}`, { scroll: false });
    }
  }, [historyTimeRange, system, sitePeriod, searchParams, router]);

  const handlePageOlder = useCallback(() => {
    if (!system) return;

    let currentStart: Date;
    let currentEnd: Date;

    if (isHistoricalMode && historyTimeRange.start && historyTimeRange.end) {
      // Already in historical mode - go back from current position
      currentStart = new Date(historyTimeRange.start);
      currentEnd = new Date(historyTimeRange.end);
    } else {
      // In live mode - go back one period from now (rounded to interval boundary)
      const intervalMinutes = getPeriodIntervalMinutes(sitePeriod);

      // Round current time down to nearest interval boundary
      const now = new Date();
      const roundedNow = new Date(now);
      const minutes = now.getMinutes();
      const roundedMinutes =
        Math.floor(minutes / intervalMinutes) * intervalMinutes;
      roundedNow.setMinutes(roundedMinutes, 0, 0); // Set seconds and ms to 0

      const duration = getPeriodDuration(sitePeriod);
      currentEnd = roundedNow;
      currentStart = new Date(roundedNow.getTime() - duration);
    }

    const duration = currentEnd.getTime() - currentStart.getTime();
    const newEnd = new Date(currentStart.getTime());
    const newStart = new Date(currentStart.getTime() - duration);

    const newStartISO = newStart.toISOString();
    const newEndISO = newEnd.toISOString();

    setHistoryTimeRange({
      start: newStartISO,
      end: newEndISO,
    });

    // Update URL with only start (period is already in URL, end can be calculated)
    const offsetMin = system.timezoneOffsetMin ?? 600;
    const params = new URLSearchParams(searchParams.toString());
    const isDateOnly = sitePeriod === "30D";
    params.set("start", encodeUrlDate(newStartISO, offsetMin, isDateOnly));
    params.delete("end"); // Remove end - it's redundant with start + period
    if (isDateOnly) {
      params.delete("offset"); // No offset for day-based periods
    } else {
      params.set("offset", encodeUrlOffset(offsetMin));
    }
    router.push(`?${params.toString()}`, { scroll: false });
  }, [
    system,
    isHistoricalMode,
    historyTimeRange,
    sitePeriod,
    searchParams,
    router,
  ]);

  // Keyboard navigation for prev/next buttons
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle arrow keys when not typing in an input
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "ArrowLeft") {
        // Left arrow = Previous/Older
        if (!historyLoading) {
          e.preventDefault();
          e.stopPropagation();
          handlePageOlder();
        }
      } else if (e.key === "ArrowRight") {
        // Right arrow = Next/Newer
        if (isHistoricalMode && !historyLoading) {
          e.preventDefault();
          e.stopPropagation();
          handlePageNewer();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyLoading, isHistoricalMode, handlePageOlder, handlePageNewer]);

  // Hover handlers that track which chart is active on touch devices
  const handleLoadHoverIndexChange = useCallback(
    (index: number | null) => {
      // On touch devices, only accept updates from the active chart
      if ("ontouchstart" in window) {
        if (index !== null) {
          // New touch - this chart becomes active
          setActiveChart("load");
          setHoveredIndex(index);
        } else if (activeChart === "load") {
          // Only clear if this was the active chart
          setHoveredIndex(null);
        }
        // Ignore clear events from non-active charts
      } else {
        // On desktop, accept all updates (normal mouse behavior)
        setHoveredIndex(index);
      }
    },
    [activeChart],
  );

  const handleGenerationHoverIndexChange = useCallback(
    (index: number | null) => {
      // On touch devices, only accept updates from the active chart
      if ("ontouchstart" in window) {
        if (index !== null) {
          // New touch - this chart becomes active
          setActiveChart("generation");
          setHoveredIndex(index);
        } else if (activeChart === "generation") {
          // Only clear if this was the active chart
          setHoveredIndex(null);
        }
        // Ignore clear events from non-active charts
      } else {
        // On desktop, accept all updates (normal mouse behavior)
        setHoveredIndex(index);
      }
    },
    [activeChart],
  );

  // Global touch handler to clear hover when touching outside charts
  useEffect(() => {
    const handleTouchOutside = (e: TouchEvent) => {
      // Check if the touch target is outside both chart containers
      const target = e.target as HTMLElement;
      const isInChart = target.closest(".site-power-chart-container");

      if (!isInChart) {
        setActiveChart(null);
        setHoveredIndex(null);
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
      {(cardVisible("chart:load") || cardVisible("chart:generation")) &&
        (historyLoading ||
          processedHistoryData.load ||
          processedHistoryData.generation ||
          system?.vendorType !== "composite") && (
          <div className="overflow-hidden">
            {/* Shared header with date/time and period switcher */}
            <div className="px-2 sm:px-4 pt-2 sm:pt-4 pb-1 sm:pb-2">
              <div className="flex justify-end items-center">
                <div className="flex items-center gap-2 sm:gap-4">
                  <span
                    className="text-xs sm:text-sm text-gray-400"
                    style={{
                      fontFamily: "DM Sans, system-ui, sans-serif",
                    }}
                  >
                    {hoveredIndex !== null &&
                    (loadChartData || generationChartData)
                      ? // Show hovered timestamp from whichever chart has data - always show time when hovering
                        format(
                          loadChartData?.timestamps[hoveredIndex] ||
                            generationChartData?.timestamps[hoveredIndex] ||
                            new Date(),
                          sitePeriod === "1D"
                            ? "h:mma"
                            : sitePeriod === "7D"
                              ? "EEE, d MMM h:mma"
                              : "EEE, d MMM",
                        )
                      : // Show date range from actual chart data when not hovering
                        (() => {
                          const chartData =
                            loadChartData || generationChartData;
                          // Get timezone offset from API data or system prop
                          const timezoneOffset = system?.timezoneOffsetMin;
                          if (!timezoneOffset) {
                            return "Loading..."; // No timezone data yet
                          }
                          if (chartData && chartData.timestamps.length > 0) {
                            const start = fromUnixTimestamp(
                              chartData.timestamps[0].getTime() / 1000,
                              timezoneOffset,
                            );
                            const end = fromUnixTimestamp(
                              chartData.timestamps[
                                chartData.timestamps.length - 1
                              ].getTime() / 1000,
                              timezoneOffset,
                            );
                            return (
                              <>
                                <span className="hidden sm:inline">
                                  {formatDateTimeRange(
                                    start,
                                    end,
                                    sitePeriod !== "30D",
                                  )}
                                </span>
                                <span className="sm:hidden">
                                  {formatDateTimeRange(start, end, false)}
                                </span>
                              </>
                            );
                          } else {
                            // Fallback to calculated range if no data yet
                            // Use historyTimeRange if in historical mode, otherwise use current time
                            if (
                              isHistoricalMode &&
                              historyTimeRange.start &&
                              historyTimeRange.end
                            ) {
                              // Use the requested historical time range
                              const start = fromUnixTimestamp(
                                new Date(historyTimeRange.start).getTime() /
                                  1000,
                                timezoneOffset,
                              );
                              const end = fromUnixTimestamp(
                                new Date(historyTimeRange.end).getTime() / 1000,
                                timezoneOffset,
                              );
                              return (
                                <>
                                  <span className="hidden sm:inline">
                                    {formatDateTimeRange(
                                      start,
                                      end,
                                      sitePeriod !== "30D",
                                    )}
                                  </span>
                                  <span className="sm:hidden">
                                    {formatDateTimeRange(start, end, false)}
                                  </span>
                                </>
                              );
                            } else {
                              // Fallback to current time if not in historical mode
                              const now = new Date();
                              let windowHours: number;
                              if (sitePeriod === "1D") windowHours = 24;
                              else if (sitePeriod === "7D")
                                windowHours = 24 * 7;
                              else windowHours = 24 * 30;
                              const windowStart = new Date(
                                now.getTime() - windowHours * 60 * 60 * 1000,
                              );
                              const start = fromUnixTimestamp(
                                windowStart.getTime() / 1000,
                                timezoneOffset,
                              );
                              const end = fromUnixTimestamp(
                                now.getTime() / 1000,
                                timezoneOffset,
                              );
                              return (
                                <>
                                  <span className="hidden sm:inline">
                                    {formatDateTimeRange(
                                      start,
                                      end,
                                      sitePeriod !== "30D",
                                    )}
                                  </span>
                                  <span className="sm:hidden">
                                    {formatDateTimeRange(start, end, false)}
                                  </span>
                                </>
                              );
                            }
                          }
                        })()}
                  </span>
                  {/* Prev/Next navigation buttons */}
                  <div
                    className="inline-flex rounded-md shadow-sm"
                    role="group"
                  >
                    <button
                      onClick={handlePageOlder}
                      className="px-2 py-1 text-sm font-medium border rounded-l-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white transition-none"
                      title="Older (Previous)"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={handlePageNewer}
                      disabled={!isHistoricalMode}
                      className="px-2 py-1 text-sm font-medium border-l-0 border rounded-r-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-none"
                      title="Newer (Next)"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  <PeriodSwitcher
                    value={sitePeriod}
                    onChange={(newPeriod) => {
                      setSitePeriod(newPeriod);
                      setHistoryTimeRange({}); // Reset to current when period changes
                      const params = new URLSearchParams(
                        searchParams.toString(),
                      );
                      params.set("period", newPeriod);
                      params.delete("start");
                      params.delete("end");
                      params.delete("offset");
                      router.push(`?${params.toString()}`, {
                        scroll: false,
                      });
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Loads Chart with Table */}
            {cardVisible("chart:load") && (
              <div className="px-2 sm:px-4 pt-1 sm:pt-2 pb-2 sm:pb-4">
                <div className="flex flex-col md:flex-row md:gap-4">
                  <div className="flex-1 min-w-0">
                    <SitePowerChart
                      systemId={parseInt(systemId as string)}
                      mode="load"
                      title="Loads"
                      className="h-full min-h-[375px]"
                      period={sitePeriod}
                      onPeriodChange={(newPeriod) => {
                        setSitePeriod(newPeriod);
                        setHistoryTimeRange({}); // Reset to current when period changes
                        const params = new URLSearchParams(
                          searchParams.toString(),
                        );
                        params.set("period", newPeriod);
                        params.delete("start");
                        params.delete("end");
                        params.delete("offset");
                        router.push(`?${params.toString()}`, {
                          scroll: false,
                        });
                      }}
                      showPeriodSwitcher={false}
                      onDataChange={setLoadChartData}
                      onHoverIndexChange={handleLoadHoverIndexChange}
                      hoveredIndex={hoveredIndex}
                      visibleSeries={
                        loadVisibleSeries.size > 0
                          ? loadVisibleSeries
                          : undefined
                      }
                      onVisibilityChange={setLoadVisibleSeries}
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
                    <SitePowerChart
                      systemId={parseInt(systemId as string)}
                      mode="generation"
                      title="Generation"
                      className="h-full min-h-[375px]"
                      period={sitePeriod}
                      onPeriodChange={(newPeriod) => {
                        setSitePeriod(newPeriod);
                        setHistoryTimeRange({}); // Reset to current when period changes
                        const params = new URLSearchParams(
                          searchParams.toString(),
                        );
                        params.set("period", newPeriod);
                        params.delete("start");
                        params.delete("end");
                        params.delete("offset");
                        router.push(`?${params.toString()}`, {
                          scroll: false,
                        });
                      }}
                      showPeriodSwitcher={false}
                      onDataChange={setGenerationChartData}
                      onHoverIndexChange={handleGenerationHoverIndexChange}
                      hoveredIndex={hoveredIndex}
                      visibleSeries={
                        generationVisibleSeries.size > 0
                          ? generationVisibleSeries
                          : undefined
                      }
                      onVisibilityChange={setGenerationVisibleSeries}
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
                // Sankey served from the server when available: 30D from the
                // materialized flow_1d endpoint, 1D/7D bundled with the history
                // response (processedHistoryData.flowMatrix). Falls back to the
                // client-side calc when neither is present (flag off / not loaded).
                const usePg = serveFlowFromPg && sitePeriod === "30D";
                const matrix =
                  usePg && pgFlowMatrix
                    ? pgFlowMatrix
                    : processedHistoryData.flowMatrix
                      ? processedHistoryData.flowMatrix
                      : calculateEnergyFlowMatrix({
                          generation: processedHistoryData.generation,
                          load: processedHistoryData.load,
                        });
                return matrix ? (
                  <div className="sm:p-4">
                    <h3 className="text-base font-semibold text-gray-300 mb-2 px-2 sm:px-0">
                      Flows
                    </h3>
                    <div className="flex justify-center">
                      <EnergyFlowSankey
                        matrix={matrix}
                        width={600}
                        height={680}
                      />
                    </div>
                  </div>
                ) : null;
              })()}
          </div>
        )}
    </>
  );
}
