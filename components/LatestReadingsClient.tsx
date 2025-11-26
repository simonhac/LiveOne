"use client";

import { useState, useEffect } from "react";
import { formatRelativeTime } from "@/lib/fe-date-format";
import { getUnitDisplay } from "@/lib/point/unit-display";

interface LatestValue {
  value: number | string;
  logicalPath: string;
  measurementTimeMs: number;
  metricUnit: string;
  displayName: string;
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
 */
function formatValueWithUnit(
  value: number | string,
  metricUnit: string,
): string {
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
}: LatestReadingsClientProps) {
  const systemId = system.id;

  const [values, setValues] = useState<LatestValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // Fetch latest values
  useEffect(() => {
    async function fetchLatest() {
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
    }

    fetchLatest();

    // Refresh every 30 seconds
    const interval = setInterval(fetchLatest, 30000);
    return () => clearInterval(interval);
  }, [systemId]);

  if (loading && values.length === 0) {
    return (
      <div className="p-4">
        <div className="text-muted-foreground">Loading latest values...</div>
      </div>
    );
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
                Logical Path
              </th>
              <th className="px-3 py-2 text-right font-medium text-gray-300">
                Value
              </th>
              <th className="px-3 py-2 text-right font-medium text-gray-300">
                Last Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {validValues.map((item, index) => {
              // Check if this row has the same name as the previous row
              const prevItem = index > 0 ? validValues[index - 1] : null;
              const isSameNameAsPrev =
                prevItem?.displayName === item.displayName;

              return (
                <tr
                  key={item.logicalPath}
                  className={`hover:bg-gray-700/50 ${
                    isSameNameAsPrev ? "" : "border-t border-gray-700/50"
                  }`}
                >
                  <td className="px-3 py-2 text-white">
                    {isSameNameAsPrev ? "" : item.displayName}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400">
                    {item.logicalPath}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-white">
                    {formatValueWithUnit(item.value, item.metricUnit)}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400">
                    {formatRelativeTime(new Date(item.measurementTimeMs))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-gray-500">
        {validValues.length} value{validValues.length !== 1 ? "s" : ""} cached
        {omittedCount > 0 && (
          <span>
            {" "}
            ({omittedCount} {omittedCount === 1 ? "entry" : "entries"} without a
            logical path omitted)
          </span>
        )}
      </div>
    </div>
  );
}
