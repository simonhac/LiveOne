"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { formatRelativeTime, formatDateTime } from "@/lib/fe-date-format";
import { getUnitDisplay } from "@/lib/point/unit-display";
import { useDashboardRefresh } from "@/hooks/useDashboardRefresh";
import SessionInfoModal from "@/components/SessionInfoModal";

interface LatestValue {
  value?: number | string | boolean;
  logicalPath: string | null;
  measurementTime?: string; // ISO8601 datetime (from jsonResponse transform)
  receivedTime?: string; // ISO8601 datetime (from jsonResponse transform)
  metricUnit: string;
  pointName: string;
  reference?: string; // Format: "systemId.pointId"
  sessionId?: number; // Session that wrote this value
  sessionLabel?: string; // Session label/name for display
}

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface LatestReadingsClientProps {
  systemIdentifier: string;
  system: {
    id: number;
    displayName: string;
  };
  userId: string;
  isAdmin: boolean;
  availableSystems: AvailableSystem[];
}

/**
 * Format a value with its unit for display
 * Returns either a string or a React element for complex displays (like location)
 */
function formatValueWithUnit(
  value: number | string | boolean,
  metricUnit: string,
): string | React.ReactElement {
  // Handle json metricUnit (e.g., location) - value is a JSON string
  if (metricUnit === "json" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed.lat !== undefined && parsed.lon !== undefined) {
        return (
          <span className="text-xs text-gray-400">
            {parsed.lat.toFixed(5)}, {parsed.lon.toFixed(5)}
          </span>
        );
      }
      return value;
    } catch {
      return value;
    }
  }

  // Handle boolean values
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  // Handle string values (like tariff codes)
  if (typeof value === "string") {
    return value;
  }

  // Format numeric values based on unit
  const displayUnit = getUnitDisplay(metricUnit);

  switch (metricUnit) {
    case "W":
    case "Wh":
      // Display raw values without scaling
      return `${value.toLocaleString()} ${displayUnit}`;
    case "%":
      return `${value.toFixed(1)}%`;
    case "cents_kWh":
      return `${value.toFixed(2)} ${displayUnit}`;
    case "cents":
      return `${value.toFixed(2)}¢`;
    case "epochMs":
      // Format as readable time
      return formatRelativeTime(new Date(value));
    case "text":
      return String(value);
    default:
      // Default: show value with unit
      if (Number.isInteger(value)) {
        return `${value.toLocaleString()} ${displayUnit}`;
      }
      return `${value.toFixed(2)} ${displayUnit}`;
  }
}

export default function LatestReadingsClient({
  system,
  availableSystems,
}: LatestReadingsClientProps) {
  const systemId = system.id;

  // Build lookup map for system names
  const systemNameMap = new Map(
    availableSystems.map((s) => [s.id, s.displayName]),
  );

  const [values, setValues] = useState<LatestValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [showSpinner, setShowSpinner] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );
  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);

  // Fetch latest values - extracted to useCallback so it can be called from refresh hook
  const fetchLatest = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/system/${systemId}/latest`);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

      const data = await response.json();
      setValues(data.values || []);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [systemId]);

  // Initial fetch and periodic refresh
  useEffect(() => {
    fetchLatest();

    // Refresh every 30 seconds
    const interval = setInterval(fetchLatest, 30000);
    return () => clearInterval(interval);
  }, [fetchLatest]);

  // Listen for dashboard refresh events (e.g., after "Poll Now" completes)
  useDashboardRefresh(fetchLatest);

  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isSessionModalOpen) {
        setIsSessionModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSessionModalOpen]);

  // Delay showing spinner by 500ms to avoid flash on quick loads
  useEffect(() => {
    if (loading && values.length === 0) {
      const timeout = setTimeout(() => {
        setShowSpinner(true);
      }, 500);
      return () => clearTimeout(timeout);
    } else {
      setShowSpinner(false);
    }
  }, [loading, values.length]);

  // Initial loading state - show spinner after 500ms delay
  if (loading && values.length === 0) {
    if (showSpinner) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center min-h-[400px]">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <div className="mt-4 text-gray-400">Loading latest values...</div>
        </div>
      );
    }
    // Still loading but spinner delay hasn't elapsed - show nothing
    return <div className="flex-1 min-h-[400px]" />;
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="text-destructive">Error: {error}</div>
      </div>
    );
  }

  // Filter out entries without a logicalPath (old/invalid entries)
  const validValues = values.filter((v) => v.logicalPath);
  const omittedCount = values.length - validValues.length;

  if (validValues.length === 0) {
    return (
      <div className="p-4">
        <div className="text-gray-400">
          No latest values cached for this system.
        </div>
        {omittedCount > 0 && (
          <div className="mt-2 text-xs text-gray-500">
            {omittedCount} {omittedCount === 1 ? "entry" : "entries"} without a
            logical path omitted.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Latest Readings</h2>
        {lastFetched && (
          <span className="text-sm text-gray-400">
            Updated {formatRelativeTime(lastFetched)}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="px-3 py-2 text-left font-medium text-gray-300">
                Name
              </th>
              <th className="px-3 py-2 text-left font-medium text-gray-300">
                Ref
              </th>
              <th className="px-3 py-2 text-left font-medium text-gray-300">
                Session
              </th>
              <th className="px-3 py-2 text-left font-medium text-gray-300">
                Logical Path
              </th>
              <th className="px-3 py-2 text-right font-medium text-gray-300">
                Time
              </th>
              <th className="px-3 py-2 text-right font-medium text-gray-300">
                Received
              </th>
              <th className="px-3 py-2 text-right font-medium text-gray-300">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {validValues.map((item, index) => {
              // Check if this row has the same name as the previous row
              const prevItem = index > 0 ? validValues[index - 1] : null;
              const isSameNameAsPrev = prevItem?.pointName === item.pointName;

              return (
                <tr
                  key={item.logicalPath}
                  className={`hover:bg-gray-700/50 ${
                    isSameNameAsPrev ? "" : "border-t border-gray-700/50"
                  }`}
                >
                  <td className="px-3 py-2 text-white">
                    {isSameNameAsPrev ? "" : item.pointName}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {item.reference ? (
                      (() => {
                        const refSystemId = parseInt(
                          item.reference.split(".")[0],
                        );
                        const systemName = systemNameMap.get(refSystemId);
                        return (
                          <span>
                            <span className="text-gray-400">
                              {systemName ?? "Unknown"}
                            </span>
                            <span className="text-gray-600">
                              {" "}
                              ID: {item.reference}
                            </span>
                          </span>
                        );
                      })()
                    ) : (
                      <span
                        className="text-yellow-500"
                        title="No source reference in cache"
                      >
                        <AlertTriangle className="w-4 h-4 inline" />
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {item.sessionId != null ? (
                      <button
                        onClick={() => {
                          setSelectedSessionId(item.sessionId);
                          setIsSessionModalOpen(true);
                        }}
                        className="text-gray-400 hover:text-blue-400 hover:underline transition-colors"
                      >
                        {item.sessionLabel || item.sessionId}
                      </button>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400">
                    {item.logicalPath}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400">
                    {item.measurementTime != null ? (
                      <span className="group relative cursor-default">
                        {formatRelativeTime(new Date(item.measurementTime))}
                        <span className="pointer-events-none absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-gray-200 opacity-0 transition-opacity delay-200 group-hover:opacity-100">
                          {
                            formatDateTime(new Date(item.measurementTime))
                              .display
                          }
                        </span>
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400">
                    {item.receivedTime != null ? (
                      <span className="group relative cursor-default">
                        {formatRelativeTime(new Date(item.receivedTime))}
                        <span className="pointer-events-none absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-gray-200 opacity-0 transition-opacity delay-200 group-hover:opacity-100">
                          {formatDateTime(new Date(item.receivedTime)).display}
                        </span>
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-white">
                    {item.value != null ? (
                      formatValueWithUnit(item.value, item.metricUnit)
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-gray-500">
        {validValues.length} point{validValues.length !== 1 ? "s" : ""}
        {(() => {
          const cachedCount = validValues.filter((v) => v.value != null).length;
          const uncachedCount = validValues.length - cachedCount;
          if (uncachedCount > 0) {
            return ` (${cachedCount} cached, ${uncachedCount} pending)`;
          }
          return "";
        })()}
        {omittedCount > 0 && (
          <span> — {omittedCount} without logical path omitted</span>
        )}
      </div>

      <SessionInfoModal
        isOpen={isSessionModalOpen}
        onClose={() => setIsSessionModalOpen(false)}
        sessionId={selectedSessionId}
      />
    </div>
  );
}
