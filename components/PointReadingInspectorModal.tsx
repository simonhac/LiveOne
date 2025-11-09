import { useEffect, useState } from "react";
import { X } from "lucide-react";
import SessionInfoModal from "./SessionInfoModal";
import { formatDateTime } from "@/lib/fe-date-format";
import { encodeUrlDateFromEpoch, encodeUrlOffset } from "@/lib/url-date";
import { PointInfo } from "@/lib/point-info";

interface SystemContext {
  name: string;
  vendorType: string;
  vendorSiteId: string | number;
  ownerUsername?: string;
  timezoneOffsetMin: number;
}

interface PointReadingInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  timestamp: number; // Unix timestamp in ms
  initialDataSource: "raw" | "5m";
  pointInfo: PointInfo;
  system: SystemContext;
}

interface ReadingData {
  measurementTime?: number; // For raw data
  intervalEnd?: number; // For 5m data
  sessionId?: number | null;
  sessionLabel?: string | null;
  // Raw data fields
  value?: number | null;
  valueStr?: string | null;
  error?: string | null;
  dataQuality?: string;
  // Agg data fields
  avg?: number | null;
  min?: number | null;
  max?: number | null;
  last?: number | null;
  delta?: number | null;
  sampleCount?: number;
  errorCount?: number;
}

export default function PointReadingInspectorModal({
  isOpen,
  onClose,
  timestamp,
  initialDataSource,
  pointInfo,
  system,
}: PointReadingInspectorModalProps) {
  const [dataSource, setDataSource] = useState<"raw" | "5m">(initialDataSource);
  const [readings, setReadings] = useState<ReadingData[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<any | null>(null);
  const [isSessionInfoModalOpen, setIsSessionInfoModalOpen] = useState(false);

  // Sync dataSource with initialDataSource when modal opens
  useEffect(() => {
    if (isOpen) {
      setDataSource(initialDataSource);
    }
  }, [isOpen, initialDataSource]);

  useEffect(() => {
    if (!isOpen) {
      setReadings([]);
      setError(null);
      return;
    }

    let cancelled = false;
    let spinnerTimeout: NodeJS.Timeout;

    const fetchReadings = async () => {
      setLoading(true);
      setShowSpinner(false);
      setError(null);

      // Delay showing spinner for 1000ms
      spinnerTimeout = setTimeout(() => {
        if (!cancelled) {
          setShowSpinner(true);
        }
      }, 1000);

      try {
        const encodedTime = encodeUrlDateFromEpoch(
          timestamp,
          system.timezoneOffsetMin,
          false,
        );
        const encodedOffset = encodeUrlOffset(system.timezoneOffsetMin);
        const response = await fetch(
          `/api/admin/point/${pointInfo.getIdentifier()}/readings?time=${encodedTime}&offset=${encodedOffset}&dataSource=${dataSource}`,
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch readings: ${response.status}`);
        }

        const data = await response.json();
        if (!cancelled) {
          setReadings(data.readings || []);
        }
      } catch (err) {
        console.error("Error fetching point readings:", err);
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load readings",
          );
        }
      } finally {
        clearTimeout(spinnerTimeout);
        if (!cancelled) {
          setLoading(false);
          setShowSpinner(false);
        }
      }
    };

    fetchReadings();

    return () => {
      cancelled = true;
      clearTimeout(spinnerTimeout);
    };
  }, [isOpen, pointInfo, timestamp, dataSource]);

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

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // Prevent the event from reaching ViewDataModal
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEsc);
      return () => document.removeEventListener("keydown", handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Find the target reading index (in chronological order, oldest first)
  const targetIndex = readings.findIndex((r) => {
    const readingTime = dataSource === "5m" ? r.intervalEnd : r.measurementTime;
    return readingTime === timestamp;
  });

  const timeField = dataSource === "5m" ? "intervalEnd" : "measurementTime";

  // Calculate which 11 readings to display (in reverse chronological order)
  // We want to show 5 before + target + 5 after, but adjust if we don't have enough on one side
  // Allow up to 10 on either side to fill 11 total rows
  const displayReadings: (ReadingData | null)[] = [];

  if (readings.length > 0 && targetIndex !== -1) {
    // Calculate ideal range: 5 before, target, 5 after
    let startIdx = Math.max(0, targetIndex - 5);
    let endIdx = Math.min(readings.length, targetIndex + 6);

    // If we don't have enough before, show more after (up to 10 after)
    if (targetIndex < 5) {
      endIdx = Math.min(readings.length, targetIndex + 11);
    }

    // If we don't have enough after, show more before (up to 10 before)
    if (targetIndex + 6 > readings.length) {
      startIdx = Math.max(0, targetIndex - 10);
    }

    // Extract the readings and reverse for display (newest first)
    const readingsToShow = readings.slice(startIdx, endIdx).reverse();

    // Pad to 11 rows
    for (let i = 0; i < 11; i++) {
      displayReadings.push(readingsToShow[i] || null);
    }
  } else {
    // No target found or no readings - show all available readings (newest first) up to 11
    const readingsToShow = [...readings].reverse();
    for (let i = 0; i < 11; i++) {
      displayReadings.push(readingsToShow[i] || null);
    }
  }

  // Get point path using PointInfo method
  const pointPath = pointInfo.getPath();

  // Helper function to format a numeric column value
  // Dynamically checks if all values in the column are whole numbers
  const formatColumnValue = (
    value: number | null | undefined,
    getColumnValues: () => (number | null | undefined)[],
  ): string => {
    if (value === null || value === undefined) return "—";

    // Check if all non-null values in this column are whole numbers
    const columnValues = getColumnValues();
    const nonNullValues = columnValues.filter(
      (v) => v !== null && v !== undefined,
    ) as number[];

    const allWhole =
      nonNullValues.length > 0 &&
      nonNullValues.every((v) => Number.isInteger(v));

    return value.toLocaleString("en-US", {
      minimumFractionDigits: allWhole ? 0 : 1,
      maximumFractionDigits: allWhole ? 0 : 1,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
      <div className="bg-gray-900 rounded-lg shadow-2xl border border-gray-700 w-full min-w-[850px] max-w-[1000px] max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4">
          <h2 className="text-lg font-semibold text-white">
            Point Readings for {system.name} {pointInfo.name}{" "}
            <span className="text-gray-500">
              ID: {pointInfo.getIdentifier()}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            {/* Raw|5m switcher - matches ViewDataModal styling */}
            <div className="flex">
              <button
                onClick={() => setDataSource("raw")}
                className={`
                  px-3 py-1 text-xs font-medium transition-colors border rounded-l-md
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
                onClick={() => setDataSource("5m")}
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
              className="p-1 hover:bg-gray-800 rounded transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pt-2 pb-2 overflow-y-auto flex-1">
          {/* Point Path and Badges */}
          {(pointPath || pointInfo.active || pointInfo.transform) && (
            <div className="flex items-center gap-3">
              {pointPath && (
                <div className="text-sm text-gray-400">
                  <span className="font-medium">Path:</span>
                  <span className="font-mono text-gray-300 ml-3">
                    {pointPath}
                  </span>
                  <span className="font-mono text-gray-500 ml-3">
                    {pointInfo.metricType} ({pointInfo.metricUnit || "—"})
                  </span>
                </div>
              )}
              {pointInfo.active && (
                <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs font-medium rounded border border-green-500/30">
                  ACTIVE
                </span>
              )}
              {pointInfo.transform === "d" && (
                <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs font-medium rounded border border-yellow-500/30">
                  DIFFERENTIATED
                </span>
              )}
              {pointInfo.transform === "i" && (
                <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs font-medium rounded border border-yellow-500/30">
                  INVERTED
                </span>
              )}
            </div>
          )}

          {/* Readings Table */}
          <div className="mt-6">
            {error && (
              <div className="text-center py-8 text-red-400">
                Error: {error}
              </div>
            )}

            {!error && (
              <div className="border border-gray-700 rounded-md overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-800 sticky top-0">
                    <tr>
                      <th
                        className="px-2 py-2 text-left text-xs font-medium text-gray-400 border-b border-gray-700"
                        style={{ width: "208px" }}
                      >
                        Time
                      </th>
                      <th
                        className="px-2 py-2 text-left text-xs font-medium text-gray-400 border-b border-gray-700"
                        style={{ width: "144px" }}
                      >
                        Session
                      </th>
                      {/* 5m columns */}
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" ? "hidden" : ""}`}
                      >
                        Avg
                      </th>
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" ? "hidden" : ""}`}
                      >
                        Min
                      </th>
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" ? "hidden" : ""}`}
                      >
                        Max
                      </th>
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" ? "hidden" : ""}`}
                      >
                        Last
                      </th>
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" || pointInfo.transform !== "d" ? "hidden" : ""}`}
                      >
                        Delta
                      </th>
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" ? "hidden" : ""}`}
                      >
                        Samples
                      </th>
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "raw" ? "hidden" : ""}`}
                      >
                        Errors
                      </th>
                      {/* Raw columns */}
                      <th
                        className={`px-2 py-2 text-right text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "5m" ? "hidden" : ""}`}
                      >
                        Value
                      </th>
                      <th
                        className={`px-2 py-2 text-left text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "5m" ? "hidden" : ""}`}
                      >
                        Quality
                      </th>
                      <th
                        className={`px-2 py-2 text-left text-xs font-medium text-gray-400 border-b border-gray-700 ${dataSource === "5m" ? "hidden" : ""}`}
                      >
                        Error
                      </th>
                    </tr>
                  </thead>
                  <tbody className="relative">
                    {showSpinner && (
                      <tr>
                        <td colSpan={12} className="absolute inset-0">
                          <div className="absolute inset-0 flex items-center justify-center z-20 bg-gray-900/50">
                            <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {loading || readings.length === 0 ? (
                      // Show empty rows while loading or when no data (11 rows to prevent size change)
                      Array.from({ length: 11 }).map((_, idx) => (
                        <tr
                          key={idx}
                          className={`h-7 ${idx % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"}`}
                        >
                          <td colSpan={12} className="py-1 px-2 text-center">
                            {!loading && idx === 5 && (
                              <span className="text-gray-400 text-xs">
                                No readings found
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <>
                        {/* Always render exactly 11 rows (newest at top) */}
                        {displayReadings.map((reading, displayIndex) => {
                          // Check if this is the target reading
                          const isTarget =
                            reading !== null &&
                            targetIndex !== -1 &&
                            (dataSource === "5m"
                              ? reading.intervalEnd
                              : reading.measurementTime) === timestamp;

                          // Use alternating colors, but highlight target
                          const bgColor = isTarget
                            ? "bg-gray-700"
                            : displayIndex % 2 === 0
                              ? "bg-gray-900/50"
                              : "bg-gray-800/50";

                          if (reading === null) {
                            // Empty row with proper height - all columns present, some hidden
                            return (
                              <tr
                                key={`empty-${displayIndex}`}
                                className={`h-7 ${bgColor}`}
                              >
                                <td className="py-1 px-2 text-xs text-gray-300 whitespace-nowrap font-mono">
                                  &nbsp;
                                </td>
                                <td className="py-1 px-2 text-xs text-gray-400">
                                  &nbsp;
                                </td>
                                {/* 5m columns */}
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" || pointInfo.transform !== "d" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right ${dataSource === "raw" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right ${dataSource === "raw" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                {/* Raw columns */}
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "5m" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 ${dataSource === "5m" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                                <td
                                  className={`py-1 px-2 text-xs text-gray-300 truncate ${dataSource === "5m" ? "hidden" : ""}`}
                                >
                                  &nbsp;
                                </td>
                              </tr>
                            );
                          }

                          // Row with data (reading is guaranteed non-null here)
                          return (
                            <tr
                              key={displayIndex}
                              className={`h-7 ${bgColor} ${isTarget ? "font-medium" : ""} hover:bg-gray-700/50 transition-colors`}
                            >
                              <td className="py-1 px-2 text-xs text-gray-300 whitespace-nowrap font-mono">
                                {reading![timeField] != null
                                  ? formatDateTime(
                                      new Date(reading![timeField]!),
                                    ).display
                                  : "—"}
                              </td>
                              <td className="py-1 px-2 text-xs text-gray-400">
                                {reading!.sessionLabel ? (
                                  <button
                                    onClick={() =>
                                      handleSessionClick(
                                        reading!.sessionId ?? null,
                                      )
                                    }
                                    className="text-xs font-mono text-gray-400 hover:text-blue-400 hover:underline cursor-pointer"
                                  >
                                    {reading!.sessionLabel}
                                  </button>
                                ) : (
                                  "—"
                                )}
                              </td>
                              {/* 5m columns */}
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                              >
                                {formatColumnValue(reading!.avg, () =>
                                  readings.map((r) => r.avg),
                                )}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                              >
                                {formatColumnValue(reading!.min, () =>
                                  readings.map((r) => r.min),
                                )}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                              >
                                {formatColumnValue(reading!.max, () =>
                                  readings.map((r) => r.max),
                                )}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" ? "hidden" : ""}`}
                              >
                                {formatColumnValue(reading!.last, () =>
                                  readings.map((r) => r.last),
                                )}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "raw" || pointInfo.transform !== "d" ? "hidden" : ""}`}
                              >
                                {formatColumnValue(reading!.delta, () =>
                                  readings.map((r) => r.delta),
                                )}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right ${dataSource === "raw" ? "hidden" : ""}`}
                              >
                                {reading!.sampleCount ?? "—"}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right ${dataSource === "raw" ? "hidden" : ""}`}
                              >
                                {reading!.errorCount ?? "—"}
                              </td>
                              {/* Raw columns */}
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 text-right font-mono ${dataSource === "5m" ? "hidden" : ""}`}
                              >
                                {reading!.valueStr ||
                                  formatColumnValue(reading!.value, () =>
                                    readings.map((r) => r.value),
                                  )}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs text-gray-300 ${dataSource === "5m" ? "hidden" : ""}`}
                              >
                                {reading!.dataQuality || "—"}
                              </td>
                              <td
                                className={`py-1 px-2 text-xs truncate ${dataSource === "5m" ? "hidden" : ""}`}
                              >
                                {reading!.error ? (
                                  <span className="text-red-400">
                                    {reading!.error}
                                  </span>
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-12 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      <SessionInfoModal
        isOpen={isSessionInfoModalOpen}
        onClose={() => setIsSessionInfoModalOpen(false)}
        session={selectedSession}
      />
    </div>
  );
}
