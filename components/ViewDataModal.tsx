"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { X } from "lucide-react";
import { formatDateTime } from "@/lib/fe-date-format";
import PointInfoModal from "./PointInfoModal";

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
}

interface ViewDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemId: number;
  systemName: string;
  vendorType: string;
  vendorSiteId: string;
}

export default function ViewDataModal({
  isOpen,
  onClose,
  systemId,
  systemName,
  vendorType,
  vendorSiteId,
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
    metricType: string;
    metricUnit: string | null;
    vendorSiteId: string;
    systemShortName?: string;
    ownerUsername: string;
    vendorType?: string;
  } | null>(null);
  const [isPointInfoModalOpen, setIsPointInfoModalOpen] = useState(false);
  const [showExtras, setShowExtras] = useState(true);
  const [dataSource, setDataSource] = useState<"raw" | "5m">("raw");

  const fetchData = useCallback(async () => {
    // Prevent duplicate fetches
    if (fetchingRef.current) {
      console.log("[ViewDataModal] Skipping duplicate fetch");
      return;
    }

    try {
      fetchingRef.current = true;
      setLoading(true);
      const response = await fetch(
        `/api/admin/systems/${systemId}/point-readings?limit=200&dataSource=${dataSource}`,
      );
      if (!response.ok) throw new Error("Failed to fetch data");

      const result = await response.json();
      setHeaders(result.headers || []);
      setData(result.data || []);
      setMetadata(result.metadata || null);
      setInitialLoad(false); // Mark initial load as complete
    } catch (error) {
      console.error("Error fetching point readings:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [systemId, dataSource]);

  useEffect(() => {
    if (isOpen) {
      setInitialLoad(true);
      fetchData();
    } else {
      // Reset state when modal closes
      setInitialLoad(true);
      fetchingRef.current = false; // Reset fetch guard
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

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && !isPointInfoModalOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, isPointInfoModalOpen, onClose]);

  const handleDataSourceChange = (newSource: "raw" | "5m") => {
    // Set loading state immediately for instant UI feedback
    if (newSource !== dataSource) {
      setLoading(true);
      setDataSource(newSource);
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
      metricType: header.type,
      metricUnit: header.unit,
      vendorSiteId: vendorSiteId,
      systemShortName: metadata?.systemShortName || undefined,
      ownerUsername: metadata?.ownerUsername || "",
      vendorType: vendorType,
    });
    setIsPointInfoModalOpen(true);
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
    },
  ) => {
    try {
      const response = await fetch(`/api/admin/points/${pointDbId}`, {
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

  if (!isOpen) return null;

  // Format value based on metric type
  const formatValue = (value: number | null, header: ColumnHeader) => {
    if (value === null) return "-";

    if (header.type === "energy") {
      // Convert Wh to MWh for energy (divide by 1,000,000)
      return `${(value / 1000000).toFixed(1)}`;
    } else if (header.type === "power") {
      // Always show power in kW to match header unit
      return `${(value / 1000).toFixed(1)}`;
    } else {
      // Default formatting
      return `${value.toFixed(0)}`;
    }
  };

  // Get unit display for header
  const getUnitDisplay = (header: ColumnHeader) => {
    if (header.key === "timestamp" || header.key === "sessionLabel") return "";

    if (header.type === "energy") {
      return "MWh";
    } else if (header.type === "power") {
      // For power, we'll show kW for most values
      return "kW";
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
    // Always show timestamp
    if (header.key === "timestamp") return true;
    // Always show columns with series ID
    if (getSeriesIdSuffix(header)) return true;
    // Only show columns without series ID if showExtras is true
    return showExtras;
  });

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
    const hasSeriesId = getSeriesIdSuffix(header) !== null;
    const nextHeader = filteredHeaders[colIndex + 1];
    const nextHasSeriesId = nextHeader
      ? getSeriesIdSuffix(nextHeader) !== null
      : false;
    const isLastSeriesIdColumn = hasSeriesId && !nextHasSeriesId;
    const isSpecialColumn =
      header.key === "timestamp" || header.key === "sessionLabel";

    return (
      <th
        key={`${header.key}-${rowKey}`}
        data-col={colIndex}
        className={`py-1 ${isLastRow ? "pb-2" : ""} px-2 align-top bg-gray-900 transition-colors ${
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

  // Generate CSS for column hover effect
  const columnHoverStyles = filteredHeaders
    .map(
      (_, colIndex) => `
    thead:has(th[data-col="${colIndex}"]:hover) th[data-col="${colIndex}"] {
      background-color: rgb(55 65 81 / 0.5) !important;
    }
  `,
    )
    .join("\n");

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
          <div className="flex items-center gap-2">
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
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-l-md -ml-px
                  ${
                    dataSource === "raw"
                      ? "bg-blue-900/50 text-blue-300 border-blue-800 z-10"
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
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
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
                {/* Row 4: Unit and Time */}
                <tr className="bg-gray-900 border-b border-gray-700">
                  {filteredHeaders.map((header, colIndex) => (
                    <HeaderCell
                      key={`${header.key}-row4`}
                      header={header}
                      colIndex={colIndex}
                      rowKey="row4"
                      isLastRow
                    >
                      {header.key === "timestamp" ? (
                        <span className="text-gray-300">Time</span>
                      ) : header.key === "sessionLabel" ? (
                        <div></div>
                      ) : getUnitDisplay(header) ? (
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
                      const hasSeriesId = getSeriesIdSuffix(header) !== null;
                      const nextHeader = filteredHeaders[colIndex + 1];
                      const nextHasSeriesId = nextHeader
                        ? getSeriesIdSuffix(nextHeader) !== null
                        : false;
                      const isLastSeriesIdColumn =
                        hasSeriesId && !nextHasSeriesId;

                      return (
                        <td
                          key={header.key}
                          className={`py-1 px-2 ${
                            header.key !== "timestamp" &&
                            header.key !== "sessionId"
                              ? "text-right"
                              : ""
                          } ${
                            isLastSeriesIdColumn
                              ? "border-r border-gray-700"
                              : ""
                          } ${!header.active && header.key !== "timestamp" && header.key !== "sessionId" ? "opacity-50" : ""}`}
                        >
                          {header.key === "timestamp" ? (
                            <span className="text-xs font-mono text-gray-300 whitespace-nowrap">
                              {formatDateTime(row[header.key]).display}
                            </span>
                          ) : header.key === "sessionLabel" ? (
                            <span className="text-xs font-mono text-gray-400">
                              {row[header.key] !== null ? row[header.key] : "-"}
                            </span>
                          ) : (
                            <span
                              className={`font-mono text-xs ${getSubsystemColor(header.subsystem)}`}
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
    </div>
  );
}
