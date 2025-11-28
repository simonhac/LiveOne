"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useModalContext } from "@/contexts/ModalContext";
import EnergyChart from "@/components/EnergyChart";
import AmberCard from "@/components/AmberCard";
import AmberNow from "@/components/AmberNow";
import SitePowerChart, { type ChartData } from "@/components/SitePowerChart";
import EnergyTable from "@/components/EnergyTable";
import { fetchAndProcessSiteData } from "@/lib/site-data-processor";
import EnergyFlowSankey from "@/components/EnergyFlowSankey";
import { calculateEnergyFlowMatrix } from "@/lib/energy-flow-matrix";
import SystemPowerCards from "@/app/components/cards/SystemPowerCards";
import PeriodSwitcher from "@/components/PeriodSwitcher";
import { formatDateTime, formatDateTimeRange } from "@/lib/fe-date-format";
import { fromUnixTimestamp, getNextMinuteBoundary } from "@/lib/date-utils";
import type { LatestPointValues } from "@/lib/types/api";
import { parseJsonWithDates } from "@/lib/json";
import {
  encodeUrlDate,
  decodeUrlDate,
  encodeUrlOffset,
  decodeUrlOffset,
} from "@/lib/url-date";
import { format } from "date-fns";
import { AlertTriangle, ChevronLeft, ChevronRight, Home } from "lucide-react";
import Link from "next/link";

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface DashboardData {
  system: {
    id: number;
    vendorType: string;
    vendorSiteId: string;
    displayName: string;
    alias: string | null;
    displayTimezone: string | null;
    ownerClerkUserId: string;
    timezoneOffsetMin: number;
    status: string;
    model: string | null;
    serial: string | null;
    ratings: string | null;
    solarSize: string | null;
    batterySize: string | null;
    location: any;
    metadata: any;
    createdAt: Date;
    updatedAt: Date;
    supportsPolling: boolean;
    pollingStatus: {
      lastPollTime: string | null;
      lastSuccessTime: string | null;
      lastErrorTime: string | null;
      lastError: string | null;
      consecutiveErrors: number;
      totalPolls: number;
      successfulPolls: number;
      isActive: boolean;
    } | null;
  };
  latest: LatestPointValues;
  historical: {
    yesterday: {
      date: string;
      energy: {
        solarKwh: number | null;
        loadKwh: number | null;
        batteryChargeKwh: number | null;
        batteryDischargeKwh: number | null;
        gridImportKwh: number | null;
        gridExportKwh: number | null;
      };
      power: {
        solar: {
          minW: number | null;
          avgW: number | null;
          maxW: number | null;
        };
        load: { minW: number | null; avgW: number | null; maxW: number | null };
        battery: {
          minW: number | null;
          avgW: number | null;
          maxW: number | null;
        };
        grid: { minW: number | null; avgW: number | null; maxW: number | null };
      };
      soc: {
        minBattery: number | null;
        avgBattery: number | null;
        maxBattery: number | null;
        endBattery: number | null;
      };
      dataQuality: {
        intervalCount: number | null;
        coverage: string | null;
      };
    } | null;
  };
}

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface DashboardClientProps {
  systemId?: string;
  system?: any; // System object from database
  hasAccess: boolean;
  systemExists: boolean;
  isAdmin: boolean;
  availableSystems?: AvailableSystem[];
  userId?: string;
}

// Helper function to get stale threshold based on vendor type
function getStaleThreshold(vendorType?: string): number {
  // 35 minutes (2100 seconds) for Enphase, 5 minutes (300 seconds) for selectronic
  return vendorType === "enphase" ? 2100 : 300;
}

export default function DashboardClient({
  systemId,
  system,
  hasAccess,
  systemExists,
  isAdmin: isAdminProp,
  availableSystems = [],
  userId,
}: DashboardClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [isAdmin, setIsAdmin] = useState(isAdminProp);
  const [currentDisplayName, setCurrentDisplayName] = useState(
    system?.displayName || "",
  );
  const [currentAlias, setCurrentAlias] = useState(system?.alias || null);
  const [currentDisplayTimezone, setCurrentDisplayTimezone] = useState(
    system?.displayTimezone || null,
  );

  // Get modal context to pause polling when modals are open
  const { isAnyModalOpen } = useModalContext();

  // Helper function to safely get a point value
  // Helper function to get a point (contains value and measurementTime)
  const getPoint = (latest: LatestPointValues | null, pointPath: string) => {
    if (!latest) return null;
    return latest[pointPath] || null;
  };

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

  const [historyFetchTrigger, setHistoryFetchTrigger] = useState(0);
  const [processedHistoryData, setProcessedHistoryData] = useState<{
    load: ChartData | null;
    generation: ChartData | null;
  }>({ load: null, generation: null });
  const [historyLoading, setHistoryLoading] = useState(false);
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

  // Function to fetch data from API
  const fetchData = useCallback(async () => {
    try {
      // systemId is now required
      if (!systemId) {
        setError("No system ID provided");
        setLoading(false);
        return;
      }
      const url = `/api/data?systemId=${systemId}`;
      const response = await fetch(url);

      // Check for token expiration specifically
      if (response.status === 404) {
        // Check the Clerk auth headers to see if this is due to token expiration
        const authStatus = response.headers.get("x-clerk-auth-status");
        const authReason = response.headers.get("x-clerk-auth-reason");
        const authMessage = response.headers.get("x-clerk-auth-message");

        if (
          authStatus === "signed-out" ||
          authReason?.includes("token-expired") ||
          authMessage?.includes("expired")
        ) {
          console.log("Session token expired");
          console.log("Auth message:", authMessage);
          // Session expired - reload will redirect to sign in
          setLoading(false);
          return;
        }
        // Otherwise it's a real 404 - system doesn't exist
      }

      // Check for other non-OK responses
      if (!response.ok) {
        // Check if the response is HTML (like a 404 page) instead of JSON
        const contentType = response.headers.get("content-type");
        if (contentType && !contentType.includes("application/json")) {
          // If we get an HTML response, it's likely a token expiration that wasn't caught above
          console.log("Non-JSON response received, likely token expired");
          setLoading(false);
          return;
        }
        throw new Error(`Failed to fetch data: ${response.status}`);
      }

      // Parse JSON with automatic date deserialization
      const result = await parseJsonWithDates(response);

      // Check if we have latest data (system info is always present)
      if (result.latest) {
        setData(result);

        // Find most recent measurement time from all points
        const timestamps = Object.values(result.latest as LatestPointValues)
          .map((point) => point?.measurementTime)
          .filter((time): time is Date => time instanceof Date);

        const dataTimestamp =
          timestamps.length > 0
            ? new Date(Math.max(...timestamps.map((t) => t.getTime())))
            : new Date();

        setLastUpdate(dataTimestamp);

        setSystemInfo(result.systemInfo || null);
        setError("");
        setLoading(false);
      } else if (result.error) {
        setError(result.error);
        setLoading(false);
      } else {
        // We have system info but no readings yet
        setData(result);
        setSystemInfo(result.systemInfo || null);
        // Don't show error for removed systems
        if (system?.status !== "removed") {
          setError("POINT_READINGS_NO_CHARTS"); // Special marker for point_readings systems
        }
        setLoading(false);
      }
    } catch (err) {
      console.error("Error fetching data:", err);

      // Check if error message indicates a 404 (which might mean token expired)
      if (err instanceof Error && err.message.includes("404")) {
        console.log("Session might be expired (404 error)");
        setLoading(false);
        return;
      }

      // Check if it's a network/connection error
      if (err instanceof TypeError && err.message === "Failed to fetch") {
        setError("Unable to connect to server");
      } else {
        setError("Failed to fetch data");
      }
      setLoading(false);
    }
  }, [systemId, system?.status]);

  // Sync local state with data when loaded (unless user has manually updated)
  useEffect(() => {
    if (data?.system?.displayName && !currentDisplayName) {
      setCurrentDisplayName(data.system.displayName);
    }
  }, [data?.system?.displayName, currentDisplayName]);

  useEffect(() => {
    if (data?.system?.displayTimezone && !currentDisplayTimezone) {
      setCurrentDisplayTimezone(data.system.displayTimezone);
    }
  }, [data?.system?.displayTimezone, currentDisplayTimezone]);

  useEffect(() => {
    // Initial fetch
    fetchData();

    // Set up polling interval (30 seconds) - but skip if modal is open
    const interval = setInterval(() => {
      if (!isAnyModalOpen) {
        fetchData();
      }
    }, 30000);

    // Cleanup on unmount
    return () => {
      clearInterval(interval);
    };
  }, [fetchData, isAnyModalOpen]);

  // Update seconds since last update and trigger refresh at 70 seconds
  // Trigger refresh 70 seconds after last update (unless modal is open)
  useEffect(() => {
    if (!lastUpdate || isAnyModalOpen) return;

    const msUntil70s = 70000 - (Date.now() - lastUpdate.getTime());
    if (msUntil70s <= 0) return; // Already past 70 seconds

    const timeout = setTimeout(() => {
      if (!isAnyModalOpen) {
        fetchData();
      }
    }, msUntil70s);

    return () => clearTimeout(timeout);
  }, [lastUpdate, fetchData, isAnyModalOpen]);

  // Fetch and process Mondo/Composite history data when needed
  useEffect(() => {
    if (
      (system?.vendorType !== "mondo" && system?.vendorType !== "composite") ||
      !systemId
    )
      return;

    let abortController = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;

    const fetchSiteData = async () => {
      setHistoryLoading(true);
      try {
        const processedData = await fetchAndProcessSiteData(
          systemId as string,
          sitePeriod,
          historyTimeRange.start,
          historyTimeRange.end,
        );

        if (!abortController.signal.aborted) {
          setProcessedHistoryData(processedData);
          setLoadChartData(processedData.load);
          setGenerationChartData(processedData.generation);
          // Store the request timestamps for navigation (only when in historical mode)
          if (
            processedData.requestStart &&
            processedData.requestEnd &&
            isHistoricalMode
          ) {
            setHistoryTimeRange({
              start: processedData.requestStart,
              end: processedData.requestEnd,
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch Mondo history data:", err);
        if (!abortController.signal.aborted) {
          setProcessedHistoryData({ load: null, generation: null });
          setLoadChartData(null);
          setGenerationChartData(null);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setHistoryLoading(false);
        }
      }
    };

    const scheduleNextFetch = () => {
      // Get next 5-minute boundary
      const nextBoundary = getNextMinuteBoundary(
        5,
        system?.timezoneOffsetMin || 0,
      );

      // Add 15 seconds to the boundary
      const targetTime = new Date(nextBoundary.toDate().getTime() + 15000);

      // Calculate delay from now
      const now = new Date();
      const delay = targetTime.getTime() - now.getTime();

      // Log scheduling details
      console.log(
        `Scheduling site history fetch for ${targetTime.toLocaleTimeString()} (${Math.round(delay / 1000)} seconds from now)`,
      );

      // Schedule the fetch (but not if delay is negative or too far in future)
      if (delay > 0 && delay < 5 * 60 * 1000) {
        timeoutId = setTimeout(() => {
          console.log(
            `Fetching Mondo data at ${new Date().toLocaleTimeString()} for system ${systemId}`,
          );
          fetchSiteData();
          // Schedule the next fetch after this one
          scheduleNextFetch();
        }, delay);
      } else {
        // If something's wrong with timing, just schedule for 5 minutes
        console.warn(
          "Delay out of expected range, falling back to 5-minute interval",
          { delay },
        );
        timeoutId = setTimeout(
          () => {
            fetchSiteData();
            scheduleNextFetch();
          },
          5 * 60 * 1000,
        );
      }
    };

    // Initial fetch
    fetchSiteData();

    // Only schedule subsequent fetches if we're not viewing historical data
    // (i.e., no start/end URL parameters)
    if (!historyTimeRange.start && !historyTimeRange.end) {
      scheduleNextFetch();
    }

    return () => {
      abortController.abort();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    systemId,
    system?.vendorType,
    system?.timezoneOffsetMin,
    sitePeriod,
    historyFetchTrigger,
    historyTimeRange.start,
    historyTimeRange.end,
    isHistoricalMode,
  ]);

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
        setHistoryFetchTrigger((prev) => prev + 1);

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
      setHistoryFetchTrigger((prev) => prev + 1);

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
    setHistoryFetchTrigger((prev) => prev + 1);

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

  // Show access denied message if user doesn't have access
  if (!hasAccess || !systemExists) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">
            Access Denied
          </h2>
          <p className="text-gray-400 mb-6">
            You don&apos;t have permission to view this system. Please contact
            your system administrator if you believe this is an error.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            <Home className="w-4 h-4" />
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

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

  if (!data && loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading Data…</p>
        </div>
      </div>
    );
  }

  const formatPower = (watts: number) => {
    return `${(watts / 1000).toFixed(1)}\u00A0kW`;
  };

  // Determine the appropriate unit for an energy value

  // Automatically determine if grid information should be shown
  // TODO: Update to use energy counter points when available
  const showGrid = data?.latest
    ? getPoint(data.latest, "bidi.grid/power") !== null
    : false;

  return (
    <main className="max-w-7xl mx-auto px-0.5 sm:px-6 lg:px-8 py-4">
      {/* Removed System Banner - Show regardless of data availability */}
      {system?.status === "removed" && (
        <div className="mb-4 p-4 bg-orange-900/50 border border-orange-700 text-orange-300 rounded-lg flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <div>
            <span className="font-semibold">
              This system has been marked as removed.
            </span>
            {!isAdmin && <span> Limited access is available.</span>}
          </div>
        </div>
      )}

      {error &&
        (error === "POINT_READINGS_NO_CHARTS" &&
        data?.system.vendorType !== "mondo" &&
        data?.system.vendorType !== "composite" ? (
          <div className="bg-blue-900/50 border border-blue-700 text-blue-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>
              Charts coming soon. Raw data is available via the settings menu.
            </span>
          </div>
        ) : error !== "POINT_READINGS_NO_CHARTS" ? (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        ) : null)}

      {(data?.latest ||
        (data &&
          (data.system.vendorType === "mondo" ||
            data.system.vendorType === "composite" ||
            data.system.vendorType === "amber"))) && (
        <div className="space-y-6">
          {/* Fault Warning
                TEMPORARILY DISABLED - Needs composite points implementation

                Previously displayed fault codes from data.latest.system.faultCode
                and timestamps from data.latest.system.faultTimestamp.

                To restore: Add fault code and timestamp as composite points, then update this section to:
                - Check getPointValue(data.latest, "system.fault/code")
                - Use getPointValue(data.latest, "system.fault/timestamp") for timing
                - Parse the measurementTime from the point value
            */}
          {/* {data.latest?.system.faultCode &&
              data.latest.system.faultCode !== 0 &&
              data.latest.system.faultTimestamp &&
              data.latest.system.faultTimestamp > 0 && (
                <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" />
                  <div>
                    <span className="font-semibold">
                      Fault Code {data.latest.system.faultCode}
                    </span>{" "}
                    encountered at{" "}
                    {
                      formatDateTime(
                        new Date(data.latest.system.faultTimestamp * 1000),
                      ).display
                    }
                  </div>
                </div>
              )} */}

          {/* Show warning for unconfigured composite systems */}
          {system?.vendorType === "composite" &&
            !historyLoading &&
            !processedHistoryData.load &&
            !processedHistoryData.generation && (
              <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <span>
                  Composite system needs to be configured before charts can be
                  displayed.
                </span>
              </div>
            )}

          {/* Amber Electric Dashboard - Live price + 48 hour timeline */}
          {data?.system.vendorType === "amber" && systemId && (
            <>
              <AmberNow latest={data.latest} />
              <AmberCard
                systemId={parseInt(systemId)}
                timezoneOffsetMin={data?.system.timezoneOffsetMin ?? 600}
                displayTimezone={data?.system.displayTimezone}
              />
            </>
          )}

          {/* Main Dashboard Grid - Only show for admin or non-removed systems and non-Amber systems */}
          {(isAdmin || system?.status !== "removed") &&
            data?.system.vendorType !== "amber" && (
              <div
                className={
                  data?.system.vendorType === "mondo" ||
                  data?.system.vendorType === "composite"
                    ? ""
                    : "flex flex-col lg:grid lg:grid-cols-3 lg:gap-4"
                }
              >
                {/* Power Cards - For non-mondo/composite: first in DOM (mobile top), sidebar on desktop */}
                {data?.system.vendorType !== "mondo" &&
                  data?.system.vendorType !== "composite" &&
                  data.latest && (
                    <div className="order-1 lg:order-2 mb-4 lg:mb-0 lg:self-stretch">
                      <SystemPowerCards
                        latest={data.latest}
                        vendorType={data.system.vendorType}
                        getStaleThreshold={getStaleThreshold}
                        showGrid={showGrid}
                        layout="sidebar"
                        className="lg:h-full"
                      />
                    </div>
                  )}

                {/* Charts - Full width for mondo/composite, 2/3 width for others */}
                <div
                  className={
                    data?.system.vendorType === "mondo" ||
                    data?.system.vendorType === "composite"
                      ? ""
                      : "order-2 lg:order-1 lg:col-span-2"
                  }
                >
                  {data?.system.vendorType === "mondo" ||
                  data?.system.vendorType === "composite" ? (
                    <>
                      {/* Power Cards - Composite and Mondo systems, horizontal grid at top */}
                      {(data?.system.vendorType === "composite" ||
                        data?.system.vendorType === "mondo") &&
                        data.latest && (
                          <SystemPowerCards
                            latest={data.latest}
                            vendorType={data.system.vendorType}
                            getStaleThreshold={getStaleThreshold}
                            showGrid={showGrid}
                          />
                        )}

                      {/* Charts - For mondo/composite systems, show charts with tables in single container */}
                      {/* Hide entire container for unconfigured composite systems */}
                      {(historyLoading ||
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
                                    fontFamily:
                                      "DM Sans, system-ui, sans-serif",
                                  }}
                                >
                                  {hoveredIndex !== null &&
                                  (loadChartData || generationChartData)
                                    ? // Show hovered timestamp from whichever chart has data - always show time when hovering
                                      format(
                                        loadChartData?.timestamps[
                                          hoveredIndex
                                        ] ||
                                          generationChartData?.timestamps[
                                            hoveredIndex
                                          ] ||
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
                                        const timezoneOffset =
                                          data?.system.timezoneOffsetMin ??
                                          system?.timezoneOffsetMin;
                                        if (!timezoneOffset) {
                                          return "Loading..."; // No timezone data yet
                                        }
                                        if (
                                          chartData &&
                                          chartData.timestamps.length > 0
                                        ) {
                                          const start = fromUnixTimestamp(
                                            chartData.timestamps[0].getTime() /
                                              1000,
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
                                                {formatDateTimeRange(
                                                  start,
                                                  end,
                                                  false,
                                                )}
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
                                              new Date(
                                                historyTimeRange.start,
                                              ).getTime() / 1000,
                                              timezoneOffset,
                                            );
                                            const end = fromUnixTimestamp(
                                              new Date(
                                                historyTimeRange.end,
                                              ).getTime() / 1000,
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
                                                  {formatDateTimeRange(
                                                    start,
                                                    end,
                                                    false,
                                                  )}
                                                </span>
                                              </>
                                            );
                                          } else {
                                            // Fallback to current time if not in historical mode
                                            const now = new Date();
                                            let windowHours: number;
                                            if (sitePeriod === "1D")
                                              windowHours = 24;
                                            else if (sitePeriod === "7D")
                                              windowHours = 24 * 7;
                                            else windowHours = 24 * 30;
                                            const windowStart = new Date(
                                              now.getTime() -
                                                windowHours * 60 * 60 * 1000,
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
                                                  {formatDateTimeRange(
                                                    start,
                                                    end,
                                                    false,
                                                  )}
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
                                    setHistoryFetchTrigger((prev) => prev + 1); // Trigger data refetch
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
                                  onHoverIndexChange={
                                    handleLoadHoverIndexChange
                                  }
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

                          {/* Generation Chart with Table */}
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
                                  onHoverIndexChange={
                                    handleGenerationHoverIndexChange
                                  }
                                  hoveredIndex={hoveredIndex}
                                  visibleSeries={
                                    generationVisibleSeries.size > 0
                                      ? generationVisibleSeries
                                      : undefined
                                  }
                                  onVisibilityChange={
                                    setGenerationVisibleSeries
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

                          {/* Energy Flow Sankey Diagram */}
                          {processedHistoryData.generation &&
                            processedHistoryData.load &&
                            (() => {
                              const matrix = calculateEnergyFlowMatrix({
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
                                  {sitePeriod === "30D" && (
                                    <div className="mt-4 px-2 sm:px-0">
                                      <div className="text-xs text-amber-400/80 bg-amber-950/20 border border-amber-800/30 rounded-md p-3">
                                        <span className="font-medium">
                                          Note:
                                        </span>{" "}
                                        Battery and grid energy values in 30D
                                        view are not yet accurate due to daily
                                        averaging. Values will be corrected when
                                        server-side energy flow calculation is
                                        implemented.
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ) : null;
                            })()}
                        </div>
                      )}
                    </>
                  ) : (
                    // For other systems, show the regular energy chart
                    <EnergyChart
                      systemId={parseInt(systemId as string)}
                      vendorType={data?.system.vendorType}
                      className="h-full min-h-[400px]"
                      maxPowerHint={(() => {
                        // Parse solar size (format: "9 kW")
                        let solarKW: number | undefined;
                        if (systemInfo?.solarSize) {
                          const solarMatch = systemInfo.solarSize.match(
                            /^(\d+(?:\.\d+)?)\s+kW$/i,
                          );
                          if (solarMatch) {
                            solarKW = parseFloat(solarMatch[1]);
                          }
                        }

                        // Parse inverter rating (format: "7.5kW, 48V")
                        let inverterKW: number | undefined;
                        if (systemInfo?.ratings) {
                          const ratingMatch =
                            systemInfo.ratings.match(/(\d+(?:\.\d+)?)kW/i);
                          if (ratingMatch) {
                            inverterKW = parseFloat(ratingMatch[1]);
                          }
                        }

                        // Return the maximum of both values, or undefined if neither parsed
                        if (solarKW !== undefined && inverterKW !== undefined) {
                          return Math.max(solarKW, inverterKW);
                        }
                        return solarKW ?? inverterKW;
                      })()}
                    />
                  )}
                </div>
              </div>
            )}

          {/* Energy Panel - Only show for admin or non-removed systems
                TEMPORARILY DISABLED - Needs composite points implementation

                Previously displayed energy data from data.latest.energy with structure:
                {
                  today: { solarKwh, loadKwh, batteryInKwh, batteryOutKwh, gridInKwh, gridOutKwh },
                  total: { solarKwh, loadKwh, batteryInKwh, batteryOutKwh, gridInKwh, gridOutKwh }
                }

                To restore: Add energy counter points to composite system, then:
                1. Create energy object from points like:
                   - getPointValue(data.latest, "source.solar/energy_today")
                   - getPointValue(data.latest, "load/energy_today")
                   - getPointValue(data.latest, "bidi.battery/energy_in_today")
                   - getPointValue(data.latest, "bidi.battery/energy_out_today")
                   - etc.
                2. Pass constructed energy object to EnergyPanel
            */}
          {/* {(isAdmin || system?.status !== "removed") && data.latest && (
              <EnergyPanel
                energy={data.latest.energy}
                historical={data.historical}
                showGrid={showGrid}
              />
            )} */}
        </div>
      )}
    </main>
  );
} // Test comment
