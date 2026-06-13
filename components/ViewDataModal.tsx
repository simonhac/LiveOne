"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
import {
  formatDateTime,
  formatDate,
  formatDateTimeRange,
  formatHoursAsDuration,
} from "@/lib/fe-date-format";
import { parseDateISO } from "@/lib/date-utils";
import {
  parseAbsolute,
  toZoned,
  type ZonedDateTime,
  type CalendarDate,
} from "@internationalized/date";
import PointInfoModal from "./PointInfoModal";
import SessionInfoModal from "./SessionInfoModal";
import PointReadingInspectorModal from "./PointReadingInspectorModal";
import { PointInfo } from "@/lib/point/point-info";
import { getContextualUnitDisplay } from "@/lib/point/unit-display";

// Group data rows by timestamp and combine session labels
function groupDataByTimestamp(data: any[]): any[] {
  if (data.length === 0) return [];

  // Group rows by timestamp (time or date)
  const timeKey = data[0].time ? "time" : "date";
  const grouped = new Map<string, any[]>();

  data.forEach((row) => {
    const timestamp = row[timeKey];
    if (!grouped.has(timestamp)) {
      grouped.set(timestamp, []);
    }
    grouped.get(timestamp)!.push(row);
  });

  // Merge rows with the same timestamp
  return Array.from(grouped.values()).map((rows) => {
    if (rows.length === 1) return rows[0];

    // Multiple rows for same timestamp - merge them
    const mergedRow = { ...rows[0] };

    // Store array of sessions for multiple links
    const sessions = rows
      .map((r) => ({
        label: r.sessionLabel,
        id: r.sessionId,
      }))
      .filter((s) => s.label !== null && s.label !== undefined);

    if (sessions.length > 0) {
      mergedRow.sessions = sessions; // Array of {label, id} objects
      mergedRow.sessionLabel = null; // Clear the single label
      mergedRow.sessionId = null; // Clear the single id
    }

    // For each point column, use the first non-null value
    Object.keys(mergedRow).forEach((key) => {
      if (
        key !== timeKey &&
        key !== "sessionLabel" &&
        key !== "sessionId" &&
        key !== "sessions"
      ) {
        const nonNullValue = rows.find((r) => r[key] !== null)?.[key];
        if (nonNullValue !== undefined) {
          mergedRow[key] = nonNullValue;
        }
      }
    });

    return mergedRow;
  });
}

interface ViewDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemId: number;
  systemName: string;
  vendorType: string;
  vendorSiteId: string;
  timezoneOffsetMin: number;
}

// Cursor carried by useInfiniteQuery's pageParam — API-shaped (string cursor + direction).
type PageParam = {
  cursor: string | null;
  direction: "older" | "newer";
};

type ParsedPagination = {
  firstCursor: ZonedDateTime | CalendarDate | null;
  lastCursor: ZonedDateTime | CalendarDate | null;
  hasOlder: boolean;
  hasNewer: boolean;
  limit: number;
};

// A single fetched window of data, already normalized for rendering.
type ViewDataPage = {
  headers: Map<string, PointInfo | null>;
  data: any[];
  metadata: any;
  pagination: ParsedPagination | null;
  // Raw API pagination cursors (strings), used to build the next/prev pageParam.
  rawFirstCursor: string | null;
  rawLastCursor: string | null;
  hasAlternativeData: boolean;
};

export default function ViewDataModal({
  isOpen,
  onClose,
  systemId,
  systemName,
  vendorType,
  vendorSiteId,
  timezoneOffsetMin,
}: ViewDataModalProps) {
  const queryClient = useQueryClient();
  const [selectedSystem, setSelectedSystem] = useState<{
    id: number;
    vendorType: string;
    vendorSiteId: string;
    displayName: string;
    alias?: string;
  } | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<PointInfo | null>(null);
  const [isPointInfoModalOpen, setIsPointInfoModalOpen] = useState(false);

  // Point Reading Inspector state
  const [selectedReading, setSelectedReading] = useState<{
    pointInfo: PointInfo;
    timestamp: ZonedDateTime | CalendarDate;
  } | null>(null);
  const [isReadingInspectorOpen, setIsReadingInspectorOpen] = useState(false);

  const [showExtras, setShowExtras] = useState(true);
  const [source, setSource] = useState<"raw" | "5m" | "daily">("raw");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [isSessionInfoModalOpen, setIsSessionInfoModalOpen] = useState(false);
  const [rawDataUnavailable, setRawDataUnavailable] = useState(false);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    if (isOpen) {
      registerModal("view-data-modal");
      return () => unregisterModal("view-data-modal");
    }
  }, [isOpen, registerModal, unregisterModal]);

  // Helper to check if cursor is CalendarDate
  const isCalendarDate = (
    cursor: ZonedDateTime | CalendarDate,
  ): cursor is CalendarDate => {
    return "day" in cursor && !("hour" in cursor);
  };

  // Tracks which end of the page list holds the most-recently-fetched window:
  // "next"/initial → last element, "previous" → first element.
  const lastDirectionRef = useRef<"next" | "previous">("next");

  // Paginated fetch of the visible 200-row window. The "next" page goes OLDER
  // (back in time, via the response's lastCursor); the "previous" page goes
  // NEWER (forward in time, via firstCursor). Only the most-recently-fetched
  // page is shown — paging replaces the window rather than accumulating rows.
  const {
    data: infiniteData,
    isFetching,
    fetchNextPage,
    fetchPreviousPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["viewData", systemId, source, timezoneOffsetMin],
    enabled: isOpen,
    initialPageParam: { cursor: null, direction: "newer" } as PageParam,
    queryFn: async ({ pageParam }): Promise<ViewDataPage> => {
      const { cursor, direction } = pageParam;

      const params = new URLSearchParams({
        limit: "200",
        source,
      });

      // Always send offset for raw/5m data
      if (source !== "daily") {
        params.set("offset", `${timezoneOffsetMin}m`); // Send as "600m" format
      }

      if (cursor !== null) {
        params.set("cursor", cursor);
        params.set("direction", direction);
      }

      const result = await fetchJson<any>(
        `/api/admin/systems/${systemId}/point-readings?${params}`,
      );

      // Convert headers object to Map
      const headersMap = new Map<string, PointInfo | null>();
      if (result.headers) {
        Object.entries(result.headers).forEach(([key, value]) => {
          headersMap.set(key, value ? PointInfo.from(value as any) : null);
        });
      }

      const rawFirstCursor = result.pagination?.firstCursor ?? null;
      const rawLastCursor = result.pagination?.lastCursor ?? null;

      // Parse pagination cursors from API (string → ZonedDateTime | CalendarDate)
      let parsedPagination: ParsedPagination | null = null;
      if (result.pagination) {
        parsedPagination = {
          ...result.pagination,
          firstCursor: rawFirstCursor
            ? source === "daily"
              ? parseDateISO(rawFirstCursor) // "2025-11-09" → CalendarDate
              : toZoned(
                  parseAbsolute(rawFirstCursor, "UTC"),
                  "Australia/Sydney",
                ) // ISO8601 → ZonedDateTime
            : null,
          lastCursor: rawLastCursor
            ? source === "daily"
              ? parseDateISO(rawLastCursor)
              : toZoned(parseAbsolute(rawLastCursor, "UTC"), "Australia/Sydney")
            : null,
        };
      }

      return {
        headers: headersMap,
        data: result.data || [],
        metadata: result.metadata || null,
        pagination: parsedPagination,
        rawFirstCursor,
        rawLastCursor,
        hasAlternativeData: result.metadata?.hasAlternativeData === true,
      };
    },
    // "next" = older data (back in time) via lastCursor.
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasOlder && lastPage.rawLastCursor
        ? { cursor: lastPage.rawLastCursor, direction: "older" as const }
        : undefined,
    // "previous" = newer data (forward in time) via firstCursor.
    getPreviousPageParam: (firstPage) =>
      firstPage.pagination?.hasNewer && firstPage.rawFirstCursor
        ? { cursor: firstPage.rawFirstCursor, direction: "newer" as const }
        : undefined,
  });

  // Only the latest fetched window is displayed (paging replaces, not appends).
  // fetchNextPage appends (last), fetchPreviousPage prepends (first).
  const pages = infiniteData?.pages;
  const currentPage = pages
    ? lastDirectionRef.current === "previous"
      ? pages[0]
      : pages[pages.length - 1]
    : null;
  const headers = currentPage?.headers ?? new Map<string, PointInfo | null>();
  // Stable identity for the empty fallback so the downstream useMemo doesn't churn each render.
  const data = useMemo(() => currentPage?.data ?? [], [currentPage]);
  const metadata = currentPage?.metadata ?? null;
  const pagination = currentPage?.pagination ?? null;
  const loading = isOpen && isFetching;

  // Reset transient view state when the modal closes.
  useEffect(() => {
    if (!isOpen) {
      setRawDataUnavailable(false); // Reset raw data unavailable flag
      setSource("raw"); // Reset to default view
    }
  }, [isOpen]);

  // Auto-switch source when the current view is empty but the alternative has data.
  // Only auto-switch between raw and 5m views, not daily.
  useEffect(() => {
    if (
      currentPage &&
      currentPage.data.length === 0 &&
      currentPage.hasAlternativeData &&
      source !== "daily"
    ) {
      console.log(
        `[ViewDataModal] No ${source} data but alternative has data, switching views`,
      );
      // Track if raw data is unavailable so we can disable the button
      if (source === "raw") {
        setRawDataUnavailable(true);
      }
      setSource(source === "raw" ? "5m" : "raw");
    }
  }, [currentPage, source]);

  const handlePageOlder = useCallback(() => {
    if (pagination?.hasOlder) {
      lastDirectionRef.current = "next";
      fetchNextPage();
    }
  }, [pagination?.hasOlder, fetchNextPage]);

  const handlePageNewer = useCallback(() => {
    if (pagination?.hasNewer) {
      lastDirectionRef.current = "previous";
      fetchPreviousPage();
    }
  }, [pagination?.hasNewer, fetchPreviousPage]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle keyboard events if modal is not open or if user is typing in an input
      if (
        !isOpen ||
        isPointInfoModalOpen ||
        isReadingInspectorOpen ||
        isSessionInfoModalOpen
      )
        return;

      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && pagination?.hasOlder && !loading) {
        e.preventDefault();
        handlePageOlder();
      } else if (e.key === "ArrowRight" && pagination?.hasNewer && !loading) {
        e.preventDefault();
        handlePageNewer();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    isOpen,
    isPointInfoModalOpen,
    isReadingInspectorOpen,
    isSessionInfoModalOpen,
    onClose,
    pagination,
    loading,
    handlePageOlder,
    handlePageNewer,
  ]);

  const handleSourceChange = (newSource: "raw" | "5m" | "daily") => {
    if (newSource !== source) {
      // Switching source changes the query key, which restarts pagination
      // from the initial (newest) window automatically.
      lastDirectionRef.current = "next";
      setSource(newSource);
    }
  };

  const handleColumnHeaderClick = (
    key: string,
    pointInfo: PointInfo | null,
  ) => {
    // Only open modal for point columns (not time/date or sessionLabel)
    if (
      key === "time" ||
      key === "date" ||
      key === "sessionLabel" ||
      !pointInfo
    )
      return;

    setSelectedSystem({
      id: systemId,
      vendorType: vendorType,
      vendorSiteId: vendorSiteId,
      displayName: systemName,
      alias: metadata?.systemShortName || undefined,
    });
    setSelectedPoint(pointInfo);
    setIsPointInfoModalOpen(true);
  };

  const handleSessionClick = (sessionId: string | null) => {
    if (sessionId === null) return;
    setSelectedSessionId(sessionId);
    setIsSessionInfoModalOpen(true);
  };

  const handleUpdatePointInfo = async (
    pointIndex: number,
    updates: {
      displayName?: string | null;
      active: boolean;
      transform?: string | null;
      logicalPathStem?: string | null;
    },
  ) => {
    try {
      const response = await fetch(
        `/api/system/${systemId}/point/${pointIndex}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
      );

      if (!response.ok) throw new Error("Failed to update point info");

      // Refresh data to show updated values
      await refetch();
    } catch (error) {
      console.error("Error updating point info:", error);
      throw error;
    }
  };

  // Format value based on metric type
  const formatValue = (
    value: number | string | null,
    pointInfo: PointInfo | null,
  ) => {
    if (value === null) return "-";

    // Handle text values (like fault codes)
    if (pointInfo?.metricUnit === "text" || typeof value === "string") {
      return String(value);
    }

    // From here on, value should be a number
    const numValue = Number(value);

    if (pointInfo?.metricType === "energy") {
      // For differentiated points in raw view, show as MWh with 3 decimal places
      if (pointInfo?.transform === "d" && source === "raw") {
        const mwh = numValue / 1_000_000;
        return `${mwh.toFixed(3)}`;
      }
      // For energy in daily view, show as kWh with 1 decimal place
      // (both differentiated counters and interval energy deltas)
      if (source === "daily") {
        const kwh = numValue / 1000;
        return `${kwh.toFixed(1)}`;
      }
      // Otherwise display in Wh (no conversion)
      return `${numValue.toFixed(0)}`;
    } else if (pointInfo?.metricType === "power") {
      // Always show power in kW to match header unit
      const kw = numValue / 1000;
      // Only show decimal if not a whole number
      return kw % 1 === 0 ? `${kw.toFixed(0)}` : `${kw.toFixed(1)}`;
    } else if (pointInfo?.metricType === "remaining") {
      // Time remaining stored in hours; show as compact "0h43m" / "1d6h" duration
      return formatHoursAsDuration(numValue);
    } else if (pointInfo?.metricUnit === "epochMs") {
      // Check for epoch 0 (Jan 1, 1970 00:00:00)
      if (numValue === 0) {
        return "epoch0";
      }
      // Format timestamp using the same formatter as the timestamp column
      // Convert milliseconds to Date object first
      return formatDateTime(new Date(numValue)).display;
    } else if (
      pointInfo?.metricUnit === "cents" ||
      pointInfo?.metricUnit === "cents_kWh"
    ) {
      // Format monetary values with 1 decimal place
      return `${numValue.toFixed(1)}`;
    } else {
      // Default formatting
      return `${numValue.toFixed(0)}`;
    }
  };

  // Get unit display for header
  const getUnitDisplay = (key: string, pointInfo: PointInfo | null) => {
    // Session label has no type/unit display
    if (key === "sessionLabel") return "";

    if (!pointInfo?.metricType) return "";

    return getContextualUnitDisplay(
      pointInfo.metricType,
      pointInfo.metricUnit,
      {
        source,
        transform: pointInfo.transform,
      },
    );
  };

  // Get subsystem color
  const getSubsystemColor = (subsystem: string | null) => {
    switch (subsystem) {
      case "solar":
        return "text-yellow-400";
      case "battery":
        return "text-green-400";
      case "grid":
        return "text-blue-400";
      case "load":
        return "text-purple-400";
      case "inverter":
        return "text-orange-400";
      default:
        return "text-gray-400";
    }
  };

  // Get label for column header
  const getHeaderLabel = (key: string, pointInfo: PointInfo | null): string => {
    if (key === "time") return "Time";
    if (key === "date") return "Date";
    if (key === "sessionLabel") return "Session";
    return pointInfo?.displayName || pointInfo?.defaultName || key;
  };

  // Get series ID suffix (without the liveone.mondo.{system} prefix)
  const getSeriesIdSuffix = (key: string, pointInfo: PointInfo | null) => {
    // Must have logicalPath to be a valid series
    const logicalPath = pointInfo?.getLogicalPath();
    if (!logicalPath) {
      console.log(
        `[ViewData] ${getHeaderLabel(key, pointInfo)}: NO logicalPath - skipping (metricType=${pointInfo?.metricType})`,
      );
      return null;
    }

    console.log(
      `[ViewData] ${getHeaderLabel(key, pointInfo)}: logicalPath=${logicalPath}`,
    );
    return logicalPath;
  };

  // Group data by timestamp and combine session labels
  const groupedData = useMemo(() => groupDataByTimestamp(data), [data]);

  // Filter headers based on showExtras state
  const filteredHeaders = Array.from(headers.entries()).filter(
    ([key, pointInfo]) => {
      // Always show time/date and session columns
      if (key === "time" || key === "date" || key === "sessionLabel")
        return true;
      // Show columns with series ID only if they are active
      if (getSeriesIdSuffix(key, pointInfo) && pointInfo?.active) return true;
      // Only show other columns (inactive with series ID, or no series ID) if showExtras is true
      return showExtras;
    },
  );

  // Generate CSS for column hover effect (exclude time/date and sessionLabel columns)
  // Memoize to prevent re-rendering and flashing when hovering
  const columnHoverStyles = useMemo(() => {
    return filteredHeaders
      .map(([key], colIndex) => {
        // Don't add hover effect for time/date or sessionLabel columns
        if (key === "time" || key === "date" || key === "sessionLabel") {
          return "";
        }
        return `
    thead:has(th[data-col="${colIndex}"]:hover) th[data-col="${colIndex}"] {
      background-color: rgb(55 65 81 / 0.5) !important;
    }
  `;
      })
      .join("\n");
  }, [filteredHeaders]);

  if (!isOpen) return null;

  // Helper component to render a header cell with common logic
  const HeaderCell = ({
    headerKey,
    pointInfo,
    colIndex,
    rowKey,
    isLastRow = false,
    children,
  }: {
    headerKey: string;
    pointInfo: PointInfo | null;
    colIndex: number;
    rowKey: string;
    isLastRow?: boolean;
    children: React.ReactNode;
  }) => {
    // Only consider active columns with series IDs for divider positioning
    const hasActiveSeriesId =
      getSeriesIdSuffix(headerKey, pointInfo) !== null && pointInfo?.active;
    const nextHeader = filteredHeaders[colIndex + 1];
    const nextHasActiveSeriesId = nextHeader
      ? getSeriesIdSuffix(nextHeader[0], nextHeader[1]) !== null &&
        nextHeader[1]?.active
      : false;
    const isLastSeriesIdColumn = hasActiveSeriesId && !nextHasActiveSeriesId;
    const isSpecialColumn =
      headerKey === "time" ||
      headerKey === "date" ||
      headerKey === "sessionLabel";

    return (
      <th
        key={`${headerKey}-${rowKey}`}
        data-col={colIndex}
        className={`py-1 ${isLastRow ? "pb-2" : ""} px-2 align-top bg-gray-900 ${
          !isSpecialColumn ? "text-right" : "text-left"
        } ${
          !isSpecialColumn && pointInfo?.index ? "cursor-pointer" : ""
        } ${isLastSeriesIdColumn ? "border-r border-gray-700" : ""} ${
          !pointInfo?.active && !isSpecialColumn ? "opacity-50" : ""
        }`}
        onClick={() => handleColumnHeaderClick(headerKey, pointInfo)}
        title={
          !isSpecialColumn && pointInfo?.index
            ? "Click to edit point info"
            : undefined
        }
      >
        {children}
      </th>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-5 z-50">
      <style>{columnHoverStyles}</style>
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h3 className="text-lg font-semibold text-white">
              Data for {systemName}{" "}
              <span className="text-gray-500">ID: {systemId}</span>
            </h3>
          </div>
          <div className="flex items-center gap-4">
            {/* Date range display */}
            {pagination &&
              data.length > 0 &&
              pagination.firstCursor &&
              pagination.lastCursor && (
                <span className="text-xs text-gray-400">
                  {(() => {
                    // Handle both CalendarDate (daily) and ZonedDateTime (raw/5m)
                    if (isCalendarDate(pagination.firstCursor!)) {
                      // Daily data: Simple date range display
                      const startDate = formatDate(
                        new Date(
                          pagination.lastCursor.year,
                          pagination.lastCursor.month - 1,
                          pagination.lastCursor.day,
                        ),
                      );
                      const endDate = formatDate(
                        new Date(
                          pagination.firstCursor.year,
                          pagination.firstCursor.month - 1,
                          pagination.firstCursor.day,
                        ),
                      );
                      return `${startDate} – ${endDate}`;
                    } else {
                      // Raw/5m data: Full time range with formatDateTimeRange
                      return formatDateTimeRange(
                        pagination.lastCursor as ZonedDateTime,
                        pagination.firstCursor as ZonedDateTime,
                        true, // Always show times for raw/5m
                      );
                    }
                  })()}
                </span>
              )}
            {/* Pagination controls */}
            <div className="inline-flex rounded-md shadow-sm" role="group">
              <button
                onClick={handlePageOlder}
                disabled={!pagination?.hasOlder || loading}
                title="Older data (back in time)"
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-l-md -ml-px
                  ${
                    pagination?.hasOlder && !loading
                      ? "bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white"
                      : "bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed"
                  }
                `}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handlePageNewer}
                disabled={!pagination?.hasNewer || loading}
                title="Newer data (forward in time)"
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-r-md -ml-px
                  ${
                    pagination?.hasNewer && !loading
                      ? "bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white"
                      : "bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed"
                  }
                `}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={() => setShowExtras(!showExtras)}
              className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors text-gray-300"
            >
              {showExtras ? "Hide" : "Show"} Extras
            </button>
            {/* Data Source Toggle */}
            <div className="inline-flex rounded-md shadow-sm" role="group">
              <button
                onClick={() => handleSourceChange("raw")}
                disabled={rawDataUnavailable}
                title={
                  rawDataUnavailable
                    ? "No raw data available - this system only has aggregated 5-minute data"
                    : undefined
                }
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-l-md -ml-px
                  ${
                    source === "raw"
                      ? "bg-blue-900/50 text-blue-300 border-blue-800 z-10"
                      : rawDataUnavailable
                        ? "bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed"
                        : "bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300"
                  }
                `}
              >
                Raw
              </button>
              <button
                onClick={() => handleSourceChange("5m")}
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border -ml-px
                  ${
                    source === "5m"
                      ? "bg-blue-900/50 text-blue-300 border-blue-800 z-10"
                      : "bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300"
                  }
                `}
              >
                5m
              </button>
              <button
                onClick={() => handleSourceChange("daily")}
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-r-md -ml-px
                  ${
                    source === "daily"
                      ? "bg-blue-900/50 text-blue-300 border-blue-800 z-10"
                      : "bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300"
                  }
                `}
              >
                Daily
              </button>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-700 rounded transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-x-auto overflow-y-auto relative">
          {/* Loading spinner - show during initial load or when switching data sources */}
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center z-20">
              <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : data.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              {metadata?.pointCount === 0 ? (
                <>
                  <p className="text-lg mb-2">
                    No monitoring points configured
                  </p>
                  <p className="text-sm">
                    This system doesn&apos;t have any point_info records yet.
                  </p>
                </>
              ) : (
                <p>No data available</p>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 text-left text-gray-400 bg-gray-900 z-10">
                {/* Row 1: Name */}
                <tr className="bg-gray-900">
                  {filteredHeaders.map(([key, pointInfo], colIndex) => (
                    <HeaderCell
                      key={`${key}-row1`}
                      headerKey={key}
                      pointInfo={pointInfo}
                      colIndex={colIndex}
                      rowKey="row1"
                    >
                      {key === "time" ? (
                        <span className="text-gray-300">Name</span>
                      ) : key === "date" ? (
                        <span className="text-gray-300">Name</span>
                      ) : key === "sessionLabel" ? (
                        <span className="text-gray-300">Session</span>
                      ) : (
                        <span
                          className={`${getSubsystemColor(pointInfo?.subsystem || null)} ${
                            !pointInfo?.active ? "line-through" : ""
                          }`}
                        >
                          {getHeaderLabel(key, pointInfo)}
                        </span>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
                {/* Row 2: Series ID */}
                <tr className="bg-gray-900">
                  {filteredHeaders.map(([key, pointInfo], colIndex) => (
                    <HeaderCell
                      key={`${key}-row2`}
                      headerKey={key}
                      pointInfo={pointInfo}
                      colIndex={colIndex}
                      rowKey="row2"
                    >
                      {key === "time" ? (
                        <span className="text-gray-300">Physical Path</span>
                      ) : key === "date" ? (
                        <span className="text-gray-300">Physical Path</span>
                      ) : key === "sessionLabel" ? (
                        <div></div>
                      ) : pointInfo?.physicalPathTail ? (
                        <span
                          className={`text-xs text-gray-500 font-mono ${
                            !pointInfo?.active ? "line-through" : ""
                          }`}
                          dangerouslySetInnerHTML={{
                            __html: pointInfo.physicalPathTail.replace(
                              /\//g,
                              "/<wbr>",
                            ),
                          }}
                        />
                      ) : (
                        <div></div>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
                {/* Row 3: Logical Path */}
                <tr className="bg-gray-900">
                  {filteredHeaders.map(([key, pointInfo], colIndex) => (
                    <HeaderCell
                      key={`${key}-row3`}
                      headerKey={key}
                      pointInfo={pointInfo}
                      colIndex={colIndex}
                      rowKey="row3"
                    >
                      {key === "time" ? (
                        <span className="text-gray-300">Logical Path</span>
                      ) : key === "date" ? (
                        <span className="text-gray-300">Logical Path</span>
                      ) : key === "sessionLabel" ? (
                        <div></div>
                      ) : pointInfo?.getLogicalPath() ? (
                        <span
                          className={`text-xs ${getSubsystemColor(pointInfo?.subsystem || null)} ${
                            !pointInfo?.active ? "line-through" : ""
                          }`}
                          dangerouslySetInnerHTML={{
                            __html:
                              pointInfo
                                .getLogicalPath()
                                ?.replace(/\./g, ".<wbr>")
                                .replace(/\//g, "/<wbr>") || "",
                          }}
                        />
                      ) : (
                        <div></div>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
                {/* Row 4: Type and Unit */}
                <tr className="bg-gray-900 border-b border-gray-700 border-t border-t-gray-600">
                  {filteredHeaders.map(([key, pointInfo], colIndex) => (
                    <HeaderCell
                      key={`${key}-row4`}
                      headerKey={key}
                      pointInfo={pointInfo}
                      colIndex={colIndex}
                      rowKey="row4"
                      isLastRow
                    >
                      {getUnitDisplay(key, pointInfo) ? (
                        <span
                          className={`text-xs text-gray-400 ${
                            !pointInfo?.active ? "line-through" : ""
                          }`}
                        >
                          {getUnitDisplay(key, pointInfo)}
                        </span>
                      ) : (
                        <div></div>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {groupedData.map((row, idx) => (
                  <tr
                    key={idx}
                    className={`group ${
                      idx % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"
                    } hover:bg-gray-700/50 transition-colors`}
                  >
                    {filteredHeaders.map(([key, pointInfo], colIndex) => {
                      // Only consider active columns with series IDs for divider positioning
                      const hasActiveSeriesId =
                        getSeriesIdSuffix(key, pointInfo) !== null &&
                        pointInfo?.active;
                      const nextHeader = filteredHeaders[colIndex + 1];
                      const nextHasActiveSeriesId = nextHeader
                        ? getSeriesIdSuffix(nextHeader[0], nextHeader[1]) !==
                            null && nextHeader[1]?.active
                        : false;
                      const isLastSeriesIdColumn =
                        hasActiveSeriesId && !nextHasActiveSeriesId;

                      return (
                        <td
                          key={key}
                          className={`py-0.5 px-2 ${
                            key !== "time" &&
                            key !== "date" &&
                            key !== "sessionLabel"
                              ? "text-right cursor-pointer"
                              : "text-left"
                          } ${
                            key === "sessionLabel"
                              ? "w-[80px] lg:w-[120px] xl:w-auto"
                              : ""
                          } ${
                            isLastSeriesIdColumn
                              ? "border-r border-gray-700"
                              : ""
                          } ${!pointInfo?.active && key !== "time" && key !== "date" && key !== "sessionLabel" ? "opacity-50" : ""}`}
                          onClick={() => {
                            // Only open inspector for data cells (not time/date or sessionLabel)
                            if (
                              key !== "time" &&
                              key !== "date" &&
                              key !== "sessionLabel" &&
                              pointInfo
                            ) {
                              // Convert plain object from API to PointInfo instance
                              const pointInfoInstance = PointInfo.from(
                                pointInfo as any,
                              );

                              // Parse time/date string to typed object
                              const timestamp = row.time
                                ? toZoned(
                                    parseAbsolute(row.time, "UTC"),
                                    "Australia/Sydney",
                                  ) // ISO8601 → ZonedDateTime
                                : parseDateISO(row.date); // YYYY-MM-DD → CalendarDate

                              setSelectedReading({
                                pointInfo: pointInfoInstance,
                                timestamp,
                              });
                              setIsReadingInspectorOpen(true);
                            }
                          }}
                        >
                          {key === "time" ? (
                            <span
                              className={`text-xs font-mono whitespace-nowrap ${
                                new Date(row[key]) > new Date()
                                  ? "text-yellow-400"
                                  : "text-gray-300"
                              }`}
                            >
                              {(() => {
                                // Parse ISO8601 string to Date for formatting
                                const date = new Date(row[key]);
                                return formatDateTime(date).display;
                              })()}
                            </span>
                          ) : key === "date" ? (
                            <span
                              className={`text-xs font-mono whitespace-nowrap ${(() => {
                                const calendarDate = parseDateISO(row[key]);
                                const jsDate = new Date(
                                  calendarDate.year,
                                  calendarDate.month - 1,
                                  calendarDate.day,
                                );
                                return jsDate > new Date()
                                  ? "text-yellow-400"
                                  : "text-gray-300";
                              })()}`}
                            >
                              {(() => {
                                const calendarDate = parseDateISO(row[key]);
                                // Convert CalendarDate to JS Date for formatting
                                const jsDate = new Date(
                                  calendarDate.year,
                                  calendarDate.month - 1,
                                  calendarDate.day,
                                );
                                return formatDate(jsDate);
                              })()}
                            </span>
                          ) : key === "sessionLabel" ? (
                            row.sessions && row.sessions.length > 0 ? (
                              <div className="flex flex-wrap gap-x-1">
                                {row.sessions.map(
                                  (
                                    session: { label: string; id: string },
                                    idx: number,
                                  ) => (
                                    <span
                                      key={idx}
                                      className="inline-flex items-center"
                                    >
                                      <button
                                        onClick={() =>
                                          handleSessionClick(session.id)
                                        }
                                        className="text-[10px] font-mono text-gray-400 hover:text-blue-400 group-hover:underline cursor-pointer break-words"
                                      >
                                        {session.label}
                                      </button>
                                      {idx < row.sessions.length - 1 && (
                                        <span className="text-gray-600 text-[10px]">
                                          ,
                                        </span>
                                      )}
                                    </span>
                                  ),
                                )}
                              </div>
                            ) : row[key] !== null && row.sessionId ? (
                              <button
                                onClick={() =>
                                  handleSessionClick(row.sessionId)
                                }
                                className="text-[10px] font-mono text-gray-400 hover:text-blue-400 group-hover:underline cursor-pointer break-words"
                              >
                                {row[key]}
                              </button>
                            ) : (
                              <span className="text-[10px] font-mono text-gray-400">
                                -
                              </span>
                            )
                          ) : (
                            <span
                              className={`font-mono text-xs hover:underline ${
                                row[key] === 0
                                  ? "text-gray-400"
                                  : getSubsystemColor(
                                      pointInfo?.subsystem || null,
                                    )
                              }`}
                            >
                              {formatValue(row[key], pointInfo)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <PointInfoModal
        isOpen={isPointInfoModalOpen}
        onClose={() => setIsPointInfoModalOpen(false)}
        system={selectedSystem}
        point={selectedPoint}
        onUpdate={handleUpdatePointInfo}
      />

      <SessionInfoModal
        isOpen={isSessionInfoModalOpen}
        onClose={() => setIsSessionInfoModalOpen(false)}
        sessionId={selectedSessionId}
      />

      {selectedReading && (
        <PointReadingInspectorModal
          isOpen={isReadingInspectorOpen}
          onClose={() => {
            setIsReadingInspectorOpen(false);
            setSelectedReading(null);
          }}
          targetTime={
            "hour" in selectedReading.timestamp
              ? selectedReading.timestamp
              : undefined
          }
          targetDate={
            "hour" in selectedReading.timestamp
              ? undefined
              : selectedReading.timestamp
          }
          initialSource={source}
          pointInfo={selectedReading.pointInfo}
          system={{
            name: systemName,
            vendorType: vendorType,
            vendorSiteId: vendorSiteId,
            ownerUsername: metadata?.ownerUsername,
            timezoneOffsetMin: metadata?.timezoneOffsetMin ?? timezoneOffsetMin,
          }}
        />
      )}
    </div>
  );
}
