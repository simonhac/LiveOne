"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDateTime } from "@/lib/fe-date-format";
import PointInfoModal from "./PointInfoModal";
import SessionInfoModal from "./SessionInfoModal";
import PointReadingInspectorModal from "./PointReadingInspectorModal";

interface ColumnHeader {
  key: string;
  label: string;
  type: string;
  unit: string | null;
  subsystem: string | null;
  pointType?: string | null;
  subtype?: string | null;
  extension?: string | null;
  originId: string;
  originSubId: string | null;
  pointDbId: number;
  systemId: number;
  defaultName: string;
  shortName: string | null;
  active: boolean;
  transform?: string | null;
  derived?: boolean;
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

export default function ViewDataModal({
  isOpen,
  onClose,
  systemId,
  systemName,
  vendorType,
  vendorSiteId,
  timezoneOffsetMin,
}: ViewDataModalProps) {
  const [headers, setHeaders] = useState<ColumnHeader[]>([]);
  const [data, setData] = useState<any[]>([]);
  const [metadata, setMetadata] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const fetchingRef = useRef(false);
  const [selectedPointInfo, setSelectedPointInfo] = useState<{
    pointDbId: number;
    systemId: number;
    originId: string;
    originSubId: string | null;
    subsystem: string | null;
    type: string | null;
    subtype: string | null;
    extension: string | null;
    defaultName: string;
    displayName: string | null;
    shortName: string | null;
    active: boolean;
    transform: string | null;
    metricType: string;
    metricUnit: string | null;
    derived: boolean;
    vendorSiteId: string;
    systemShortName?: string;
    ownerUsername: string;
    vendorType?: string;
  } | null>(null);
  const [isPointInfoModalOpen, setIsPointInfoModalOpen] = useState(false);

  // Point Reading Inspector state
  const [selectedReading, setSelectedReading] = useState<{
    header: ColumnHeader;
    timestamp: number;
  } | null>(null);
  const [isReadingInspectorOpen, setIsReadingInspectorOpen] = useState(false);

  const [showExtras, setShowExtras] = useState(true);
  const [dataSource, setDataSource] = useState<"raw" | "5m">("raw");
  const [selectedSession, setSelectedSession] = useState<any | null>(null);
  const [isSessionInfoModalOpen, setIsSessionInfoModalOpen] = useState(false);
  const [rawDataUnavailable, setRawDataUnavailable] = useState(false);
  const [pagination, setPagination] = useState<{
    firstCursor: number | null;
    lastCursor: number | null;
    hasOlder: boolean;
    hasNewer: boolean;
    limit: number;
  } | null>(null);
  const [currentCursor, setCurrentCursor] = useState<number | null>(null);
  const [cursorDirection, setCursorDirection] = useState<"older" | "newer">(
    "newer",
  );

  const fetchData = useCallback(async () => {
    // Prevent duplicate fetches
    if (fetchingRef.current) {
      console.log("[ViewDataModal] Skipping duplicate fetch");
      return;
    }

    try {
      fetchingRef.current = true;
      setLoading(true);

      // Build URL with pagination parameters
      const params = new URLSearchParams({
        limit: "200",
        dataSource,
      });

      if (currentCursor !== null) {
        params.set("cursor", currentCursor.toString());
        params.set("direction", cursorDirection);
      }

      const response = await fetch(
        `/api/admin/systems/${systemId}/point-readings?${params}`,
      );
      if (!response.ok) throw new Error("Failed to fetch data");

      const result = await response.json();
      setHeaders(result.headers || []);
      setData(result.data || []);
      setMetadata(result.metadata || null);
      setPagination(result.pagination || null);
      setInitialLoad(false); // Mark initial load as complete

      // If no data in current view but alternative has data, switch views
      if (
        result.data.length === 0 &&
        result.metadata?.hasAlternativeData === true
      ) {
        console.log(
          `[ViewDataModal] No ${dataSource} data but alternative has data, switching views`,
        );
        // Track if raw data is unavailable so we can disable the button
        if (dataSource === "raw") {
          setRawDataUnavailable(true);
        }
        setDataSource(dataSource === "raw" ? "5m" : "raw");
      }
    } catch (error) {
      console.error("Error fetching point readings:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [systemId, dataSource, currentCursor, cursorDirection]);

  useEffect(() => {
    if (isOpen) {
      setInitialLoad(true);
      fetchData();
    } else {
      // Reset state when modal closes
      setInitialLoad(true);
      fetchingRef.current = false; // Reset fetch guard
      setRawDataUnavailable(false); // Reset raw data unavailable flag
      setDataSource("raw"); // Reset to default view
      setCurrentCursor(null); // Reset pagination
      setCursorDirection("newer");
      setPagination(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]); // Intentionally exclude fetchData to prevent double calls

  // Refetch when data source changes
  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource]);

  // Refetch when pagination changes
  useEffect(() => {
    if (isOpen && (currentCursor !== null || cursorDirection !== "newer")) {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCursor, cursorDirection]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        isOpen &&
        !isPointInfoModalOpen &&
        !isReadingInspectorOpen
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, isPointInfoModalOpen, isReadingInspectorOpen, onClose]);

  const handleDataSourceChange = (newSource: "raw" | "5m") => {
    // Set loading state immediately for instant UI feedback
    if (newSource !== dataSource) {
      setLoading(true);
      setDataSource(newSource);
      // Reset pagination when switching data sources
      setCurrentCursor(null);
      setCursorDirection("newer");
      setPagination(null);
    }
  };

  const handlePageOlder = () => {
    if (pagination?.lastCursor) {
      setCurrentCursor(pagination.lastCursor);
      setCursorDirection("older");
      setLoading(true);
    }
  };

  const handlePageNewer = () => {
    if (pagination?.firstCursor) {
      setCurrentCursor(pagination.firstCursor);
      setCursorDirection("newer");
      setLoading(true);
    }
  };

  const handleColumnHeaderClick = (header: ColumnHeader) => {
    // Only open modal for point columns (not timestamp or sessionLabel)
    if (header.key === "timestamp" || header.key === "sessionLabel") return;

    setSelectedPointInfo({
      pointDbId: header.pointDbId,
      systemId: header.systemId,
      originId: header.originId,
      originSubId: header.originSubId || null,
      subsystem: header.subsystem,
      type: header.pointType || null,
      subtype: header.subtype || null,
      extension: header.extension || null,
      defaultName: header.defaultName || header.label,
      displayName: header.label,
      shortName: header.shortName || null,
      active: header.active,
      transform: header.transform || null,
      metricType: header.type,
      metricUnit: header.unit,
      derived: header.derived || false,
      vendorSiteId: vendorSiteId,
      systemShortName: metadata?.systemShortName || undefined,
      ownerUsername: metadata?.ownerUsername || "",
      vendorType: vendorType,
    });
    setIsPointInfoModalOpen(true);
  };

  const handleSessionClick = async (sessionId: number | null) => {
    if (sessionId === null) return;

    // Delay showing wait cursor by 500ms
    const cursorTimeout = setTimeout(() => {
      document.body.style.cursor = "wait";
    }, 500);

    try {
      const response = await fetch(`/api/admin/sessions/${sessionId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch session: ${response.status}`);
      }
      const data = await response.json();

      // Clear timeout and reset cursor
      clearTimeout(cursorTimeout);
      document.body.style.cursor = "";

      // Set session data and open modal
      setSelectedSession(data.session);
      setIsSessionInfoModalOpen(true);
    } catch (error) {
      console.error("Error fetching session:", error);
      clearTimeout(cursorTimeout);
      document.body.style.cursor = "";
      // Could show an error toast here if desired
    }
  };

  const handleUpdatePointInfo = async (
    pointDbId: number,
    updates: {
      type?: string | null;
      subtype?: string | null;
      extension?: string | null;
      displayName?: string | null;
      shortName?: string | null;
      active: boolean;
      transform?: string | null;
    },
  ) => {
    try {
      // Use composite key format: systemId.pointId
      const compositeKey = `${systemId}.${pointDbId}`;
      const response = await fetch(`/api/admin/point/${compositeKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!response.ok) throw new Error("Failed to update point info");

      // Refresh data to show updated values
      await fetchData();

      // Update the selected point info to reflect changes
      if (selectedPointInfo) {
        setSelectedPointInfo({
          ...selectedPointInfo,
          ...updates,
        });
      }
    } catch (error) {
      console.error("Error updating point info:", error);
      throw error;
    }
  };

  // Format value based on metric type
  const formatValue = (value: number | string | null, header: ColumnHeader) => {
    if (value === null) return "-";

    // Handle text values (like fault codes)
    if (header.unit === "text" || typeof value === "string") {
      return String(value);
    }

    // From here on, value should be a number
    const numValue = Number(value);

    if (header.type === "energy") {
      // Display interval energy in Wh (no conversion)
      return `${numValue.toFixed(0)}`;
    } else if (header.type === "power") {
      // Always show power in kW to match header unit
      const kw = numValue / 1000;
      // Only show decimal if not a whole number
      return kw % 1 === 0 ? `${kw.toFixed(0)}` : `${kw.toFixed(1)}`;
    } else if (header.unit === "epochMs") {
      // Check for epoch 0 (Jan 1, 1970 00:00:00)
      if (numValue === 0) {
        return "epoch0";
      }
      // Format timestamp using the same formatter as the timestamp column
      // Convert milliseconds to Date object first
      return formatDateTime(new Date(numValue)).display;
    } else {
      // Default formatting
      return `${numValue.toFixed(0)}`;
    }
  };

  // Get unit display for header
  const getUnitDisplay = (header: ColumnHeader) => {
    // Session label has no type/unit display
    if (header.key === "sessionLabel") return "";

    if (header.type === "energy") {
      return "Wh";
    } else if (header.type === "power") {
      // For power, we'll show kW for most values
      return "kW";
    } else if (header.type === "time" && header.unit === "epochMs") {
      // Show just "time" for time columns
      return "time";
    } else if (header.unit) {
      return header.unit;
    }
    return "";
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

  // Get series ID suffix (without the liveone.mondo.{system} prefix)
  const getSeriesIdSuffix = (header: ColumnHeader) => {
    // Must have pointType to be a valid series
    if (!header.pointType) {
      console.log(
        `[ViewData] ${header.label}: NO pointType - skipping (subtype=${header.subtype}, ext=${header.extension}, metricType=${header.type})`,
      );
      return null;
    }

    const parts = [];
    if (header.pointType) parts.push(header.pointType);
    if (header.subtype) parts.push(header.subtype);
    if (header.extension) parts.push(header.extension);
    if (header.type) parts.push(header.type); // metricType

    const seriesId = parts.join(".");
    console.log(
      `[ViewData] ${header.label}: pointType=${header.pointType}, subtype=${header.subtype}, ext=${header.extension}, metricType=${header.type} => seriesId=${seriesId || "NULL"}`,
    );
    return seriesId || null;
  };

  // Filter headers based on showExtras state
  const filteredHeaders = headers.filter((header) => {
    // Always show timestamp and session columns
    if (header.key === "timestamp" || header.key === "sessionLabel")
      return true;
    // Show columns with series ID only if they are active
    if (getSeriesIdSuffix(header) && header.active) return true;
    // Only show other columns (inactive with series ID, or no series ID) if showExtras is true
    return showExtras;
  });

  // Generate CSS for column hover effect (exclude timestamp and sessionLabel columns)
  // Memoize to prevent re-rendering and flashing when hovering
  const columnHoverStyles = useMemo(() => {
    return filteredHeaders
      .map((header, colIndex) => {
        // Don't add hover effect for timestamp or sessionLabel columns
        if (header.key === "timestamp" || header.key === "sessionLabel") {
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
    header,
    colIndex,
    rowKey,
    isLastRow = false,
    children,
  }: {
    header: ColumnHeader;
    colIndex: number;
    rowKey: string;
    isLastRow?: boolean;
    children: React.ReactNode;
  }) => {
    // Only consider active columns with series IDs for divider positioning
    const hasActiveSeriesId =
      getSeriesIdSuffix(header) !== null && header.active;
    const nextHeader = filteredHeaders[colIndex + 1];
    const nextHasActiveSeriesId = nextHeader
      ? getSeriesIdSuffix(nextHeader) !== null && nextHeader.active
      : false;
    const isLastSeriesIdColumn = hasActiveSeriesId && !nextHasActiveSeriesId;
    const isSpecialColumn =
      header.key === "timestamp" || header.key === "sessionLabel";

    return (
      <th
        key={`${header.key}-${rowKey}`}
        data-col={colIndex}
        className={`py-1 ${isLastRow ? "pb-2" : ""} px-2 align-top bg-gray-900 ${
          !isSpecialColumn ? "text-right" : ""
        } ${
          !isSpecialColumn && header.pointDbId ? "cursor-pointer" : ""
        } ${isLastSeriesIdColumn ? "border-r border-gray-700" : ""} ${
          !header.active && !isSpecialColumn ? "opacity-50" : ""
        }`}
        onClick={() => handleColumnHeaderClick(header)}
        title={
          !isSpecialColumn && header.pointDbId
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
              {vendorType && <> — {vendorType}</>}
            </h3>
          </div>
          <div className="flex items-center gap-4">
            {/* Date range display */}
            {pagination && data.length > 0 && (
              <span className="text-xs text-gray-400">
                {formatDateTime(new Date(pagination.firstCursor!)).display}
                {" to "}
                {formatDateTime(new Date(pagination.lastCursor!)).display}
              </span>
            )}
            {/* Pagination controls */}
            <div className="inline-flex rounded-md shadow-sm" role="group">
              <button
                onClick={handlePageNewer}
                disabled={!pagination?.hasNewer || loading}
                title="Newer data (forward in time)"
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-l-md -ml-px
                  ${
                    pagination?.hasNewer && !loading
                      ? "bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white"
                      : "bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed"
                  }
                `}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handlePageOlder}
                disabled={!pagination?.hasOlder || loading}
                title="Older data (back in time)"
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-r-md -ml-px
                  ${
                    pagination?.hasOlder && !loading
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
                onClick={() => handleDataSourceChange("raw")}
                disabled={rawDataUnavailable}
                title={
                  rawDataUnavailable
                    ? "No raw data available - this system only has aggregated 5-minute data"
                    : undefined
                }
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-l-md -ml-px
                  ${
                    dataSource === "raw"
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
                onClick={() => handleDataSourceChange("5m")}
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-r-md -ml-px
                  ${
                    dataSource === "5m"
                      ? "bg-blue-900/50 text-blue-300 border-blue-800 z-10"
                      : "bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300"
                  }
                `}
              >
                5m
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
                  {filteredHeaders.map((header, colIndex) => (
                    <HeaderCell
                      key={`${header.key}-row1`}
                      header={header}
                      colIndex={colIndex}
                      rowKey="row1"
                    >
                      {header.key === "timestamp" ? (
                        <span className="text-gray-300">Name</span>
                      ) : header.key === "sessionLabel" ? (
                        <span className="text-gray-300">Session</span>
                      ) : (
                        <span
                          className={`${getSubsystemColor(header.subsystem)} ${
                            !header.active ? "line-through" : ""
                          }`}
                        >
                          {header.label}
                        </span>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
                {/* Row 2: Series ID */}
                <tr className="bg-gray-900">
                  {filteredHeaders.map((header, colIndex) => (
                    <HeaderCell
                      key={`${header.key}-row2`}
                      header={header}
                      colIndex={colIndex}
                      rowKey="row2"
                    >
                      {header.key === "timestamp" ? (
                        <span className="text-gray-300">Series</span>
                      ) : header.key === "sessionLabel" ? (
                        <div></div>
                      ) : getSeriesIdSuffix(header) ? (
                        <span
                          className={`text-xs text-gray-500 font-mono ${
                            !header.active ? "line-through" : ""
                          }`}
                          dangerouslySetInnerHTML={{
                            __html:
                              getSeriesIdSuffix(header)?.replace(
                                /\./g,
                                ".<wbr />",
                              ) || "",
                          }}
                        />
                      ) : (
                        <div></div>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
                {/* Row 3: Short name */}
                <tr className="bg-gray-900">
                  {filteredHeaders.map((header, colIndex) => (
                    <HeaderCell
                      key={`${header.key}-row3`}
                      header={header}
                      colIndex={colIndex}
                      rowKey="row3"
                    >
                      {header.key === "timestamp" ? (
                        <span className="text-gray-300">Alias</span>
                      ) : header.key === "sessionLabel" ? (
                        <div></div>
                      ) : header.shortName ? (
                        <span
                          className={`text-xs ${getSubsystemColor(header.subsystem)} ${
                            !header.active ? "line-through" : ""
                          }`}
                        >
                          {header.shortName}
                        </span>
                      ) : (
                        <div></div>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
                {/* Row 4: Type and Unit */}
                <tr className="bg-gray-900 border-b border-gray-700 border-t border-t-gray-600">
                  {filteredHeaders.map((header, colIndex) => (
                    <HeaderCell
                      key={`${header.key}-row4`}
                      header={header}
                      colIndex={colIndex}
                      rowKey="row4"
                      isLastRow
                    >
                      {getUnitDisplay(header) ? (
                        <span
                          className={`text-xs text-gray-400 ${
                            !header.active ? "line-through" : ""
                          }`}
                        >
                          {getUnitDisplay(header)}
                        </span>
                      ) : (
                        <div></div>
                      )}
                    </HeaderCell>
                  ))}
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {data.map((row, idx) => (
                  <tr
                    key={idx}
                    className={`${
                      idx % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"
                    } hover:bg-gray-700/50 transition-colors`}
                  >
                    {filteredHeaders.map((header, colIndex) => {
                      // Only consider active columns with series IDs for divider positioning
                      const hasActiveSeriesId =
                        getSeriesIdSuffix(header) !== null && header.active;
                      const nextHeader = filteredHeaders[colIndex + 1];
                      const nextHasActiveSeriesId = nextHeader
                        ? getSeriesIdSuffix(nextHeader) !== null &&
                          nextHeader.active
                        : false;
                      const isLastSeriesIdColumn =
                        hasActiveSeriesId && !nextHasActiveSeriesId;

                      // Get background color for derived points
                      const getDerivedBg = (header: ColumnHeader) => {
                        if (!header.derived) return undefined;
                        // Use subsystem color with low opacity for tint
                        switch (header.subsystem) {
                          case "solar":
                            return "rgba(234, 179, 8, 0.08)"; // yellow-500 at 8% opacity
                          case "battery":
                            return "rgba(34, 197, 94, 0.08)"; // green-500 at 8% opacity
                          case "grid":
                            return "rgba(59, 130, 246, 0.08)"; // blue-500 at 8% opacity
                          case "load":
                            return "rgba(239, 68, 68, 0.08)"; // red-500 at 8% opacity
                          default:
                            return "rgba(156, 163, 175, 0.08)"; // gray-400 at 8% opacity
                        }
                      };

                      return (
                        <td
                          key={header.key}
                          className={`py-1 px-2 ${
                            header.key !== "timestamp" &&
                            header.key !== "sessionLabel"
                              ? "text-right cursor-pointer"
                              : ""
                          } ${
                            isLastSeriesIdColumn
                              ? "border-r border-gray-700"
                              : ""
                          } ${!header.active && header.key !== "timestamp" && header.key !== "sessionLabel" ? "opacity-50" : ""}`}
                          style={{ backgroundColor: getDerivedBg(header) }}
                          onClick={() => {
                            // Only open inspector for data cells (not timestamp or sessionLabel)
                            if (
                              header.key !== "timestamp" &&
                              header.key !== "sessionLabel"
                            ) {
                              setSelectedReading({
                                header,
                                timestamp: row.timestamp,
                              });
                              setIsReadingInspectorOpen(true);
                            }
                          }}
                        >
                          {header.key === "timestamp" ? (
                            <span className="text-xs font-mono text-gray-300 whitespace-nowrap">
                              {
                                formatDateTime(new Date(row[header.key]))
                                  .display
                              }
                            </span>
                          ) : header.key === "sessionLabel" ? (
                            row[header.key] !== null && row.sessionId ? (
                              <button
                                onClick={() =>
                                  handleSessionClick(row.sessionId)
                                }
                                className="text-xs font-mono text-gray-400 hover:text-blue-400 hover:underline cursor-pointer"
                              >
                                {row[header.key]}
                              </button>
                            ) : (
                              <span className="text-xs font-mono text-gray-400">
                                -
                              </span>
                            )
                          ) : (
                            <span
                              className={`font-mono text-xs hover:underline ${getSubsystemColor(header.subsystem)}`}
                            >
                              {formatValue(row[header.key], header)}
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
        pointInfo={selectedPointInfo}
        onUpdate={handleUpdatePointInfo}
      />

      <SessionInfoModal
        isOpen={isSessionInfoModalOpen}
        onClose={() => setIsSessionInfoModalOpen(false)}
        session={selectedSession}
      />

      {selectedReading && (
        <PointReadingInspectorModal
          isOpen={isReadingInspectorOpen}
          onClose={() => {
            setIsReadingInspectorOpen(false);
            setSelectedReading(null);
          }}
          timestamp={selectedReading.timestamp}
          initialDataSource={dataSource}
          header={selectedReading.header}
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
