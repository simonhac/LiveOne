"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import HeatmapChart from "@/components/HeatmapChart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/chart-colors";
import { SystemIdentifier } from "@/lib/identifiers";
import type { ZonedDateTime } from "@internationalized/date";
import { toZoned } from "@internationalized/date";

interface PointInfo {
  path: string;
  name: string;
  metricType: string;
  metricUnit: string;
  reference: string;
  active: boolean;
}

interface SystemInfo {
  id: number;
  displayTimezone: string | null;
  displayName: string;
}

export default function HeatmapPage() {
  const params = useParams();
  const systemIdentifier = params.systemIdentifier as string;

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [points, setPoints] = useState<PointInfo[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<string | undefined>(
    undefined,
  );
  const [selectedPalette, setSelectedPalette] =
    useState<HeatmapPaletteKey>("viridis");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchInfo, setFetchInfo] = useState<{
    interval: string;
    duration: string;
    startTime: ZonedDateTime | null;
    endTime: ZonedDateTime | null;
  } | null>(null);

  // Fetch system info and points on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Parse system identifier to get system ID
        const parsedIdentifier = SystemIdentifier.parse(systemIdentifier);
        if (!parsedIdentifier) {
          throw new Error("Invalid system identifier");
        }

        // For username.shortname format, we need to resolve it to a systemId
        // For now, we'll fetch points which includes system info
        const pointsResponse = await fetch(
          `/api/system/${systemIdentifier}/points`,
          {
            credentials: "same-origin",
          },
        );

        if (!pointsResponse.ok) {
          throw new Error(
            `Failed to fetch points: ${pointsResponse.statusText}`,
          );
        }

        const pointsData = await pointsResponse.json();

        if (!pointsData.points || pointsData.points.length === 0) {
          throw new Error("No points found for this system");
        }

        setPoints(pointsData.points);

        // Extract system ID from the first point's reference (format: "systemId.pointIndex")
        const systemId = parseInt(pointsData.points[0].reference.split(".")[0]);

        // Fetch system info from SystemsManager (we'll use the dashboard API pattern)
        // For now, we'll use a default timezone and get it from a different source
        // Let's fetch from the dashboard data endpoint
        const systemResponse = await fetch(`/api/data?systemId=${systemId}`, {
          credentials: "same-origin",
        });

        if (systemResponse.ok) {
          const systemData = await systemResponse.json();
          setSystem({
            id: systemId,
            displayTimezone:
              systemData.system?.displayTimezone || "Australia/Sydney",
            displayName: systemData.system?.displayName || "System",
          });
        } else {
          // Fallback to default timezone
          setSystem({
            id: systemId,
            displayTimezone: "Australia/Sydney",
            displayName: "System",
          });
        }

        // Auto-select first point
        if (pointsData.points.length > 0) {
          setSelectedPoint(pointsData.points[0].path);
        }

        setLoading(false);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    };

    fetchData();
  }, [systemIdentifier]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-800 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-800 flex items-center justify-center">
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }

  if (!system || points.length === 0) {
    return (
      <div className="min-h-screen bg-gray-800 flex items-center justify-center">
        <div className="text-gray-400">No data available</div>
      </div>
    );
  }

  const selectedPointInfo = points.find((p) => p.path === selectedPoint);

  // Debug logging
  console.log("selectedPoint:", selectedPoint);
  console.log("points:", points);
  console.log("selectedPointInfo:", selectedPointInfo);
  console.log("will render heatmap:", !!(selectedPoint && selectedPointInfo));

  return (
    <div className="min-h-screen bg-gray-800 text-gray-200">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">
            {system.displayName} — Heatmap
          </h1>
          <p className="text-gray-400 text-sm">
            30-day view at 30-minute intervals
          </p>
        </div>

        {/* Controls */}
        <div className="mb-6 flex flex-wrap gap-4">
          {/* Point selector */}
          <div className="flex-1 min-w-[300px]">
            <label className="block text-sm text-gray-400 mb-2">
              Select Point
            </label>
            <Select value={selectedPoint} onValueChange={setSelectedPoint}>
              <SelectTrigger className="bg-gray-900 border-gray-700">
                <SelectValue placeholder="Select a point" />
              </SelectTrigger>
              <SelectContent>
                {points.map((point) => (
                  <SelectItem key={point.reference} value={point.path}>
                    <div className="flex flex-col">
                      <div>
                        {point.name} ({point.metricType})
                      </div>
                      <div className="text-xs text-gray-500">{point.path}</div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Palette selector */}
          <div className="w-64">
            <label className="block text-sm text-gray-400 mb-2">
              Color Palette
            </label>
            <Select
              value={selectedPalette}
              onValueChange={(value) =>
                setSelectedPalette(value as HeatmapPaletteKey)
              }
            >
              <SelectTrigger className="bg-gray-900 border-gray-700">
                <SelectValue>
                  {(() => {
                    const config = HEATMAP_PALETTES[selectedPalette];
                    const gradientStops = [0, 0.25, 0.5, 0.75, 1]
                      .map((t) => config.fn(t))
                      .join(", ");

                    return (
                      <div className="flex items-center gap-2 w-full">
                        <div
                          className="h-4 rounded flex-1 min-w-[120px]"
                          style={{
                            background: `linear-gradient(to right, ${gradientStops})`,
                          }}
                        />
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                          {config.name}
                        </span>
                      </div>
                    );
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(HEATMAP_PALETTES).map(([key, config]) => {
                  // Generate gradient preview
                  const gradientStops = [0, 0.25, 0.5, 0.75, 1]
                    .map((t) => config.fn(t))
                    .join(", ");

                  return (
                    <SelectItem key={key} value={key}>
                      <div className="flex items-center gap-2 w-full">
                        <div
                          className="h-4 rounded flex-1 min-w-[120px]"
                          style={{
                            background: `linear-gradient(to right, ${gradientStops})`,
                          }}
                        />
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                          {config.name}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Debug info */}
        {fetchInfo && (
          <div className="mb-4 text-xs text-gray-400">
            <table>
              <tbody>
                <tr>
                  <td className="pr-4 align-top">Timezone:</td>
                  <td>{system.displayTimezone}</td>
                </tr>
                <tr>
                  <td className="pr-4 align-top">Interval:</td>
                  <td>
                    {fetchInfo.interval} over {fetchInfo.duration}
                  </td>
                </tr>
                <tr>
                  <td className="pr-4 align-top">Range:</td>
                  <td>
                    <div>
                      {fetchInfo.startTime &&
                        (() => {
                          const aestStart = toZoned(
                            fetchInfo.startTime,
                            "+10:00",
                          );
                          return `${aestStart.year}-${String(aestStart.month).padStart(2, "0")}-${String(aestStart.day).padStart(2, "0")} ${String(aestStart.hour).padStart(2, "0")}:${String(aestStart.minute).padStart(2, "0")}`;
                        })()}{" "}
                      <span className="text-[0.6em] text-gray-600">AEST</span>
                      {" → "}
                      {fetchInfo.endTime &&
                        (() => {
                          const aestEnd = toZoned(fetchInfo.endTime, "+10:00");
                          return `${aestEnd.year}-${String(aestEnd.month).padStart(2, "0")}-${String(aestEnd.day).padStart(2, "0")} ${String(aestEnd.hour).padStart(2, "0")}:${String(aestEnd.minute).padStart(2, "0")}`;
                        })()}{" "}
                      <span className="text-[0.6em] text-gray-600">AEST</span>
                    </div>
                    <div>
                      {fetchInfo.startTime &&
                        `${fetchInfo.startTime.year}-${String(fetchInfo.startTime.month).padStart(2, "0")}-${String(fetchInfo.startTime.day).padStart(2, "0")} ${String(fetchInfo.startTime.hour).padStart(2, "0")}:${String(fetchInfo.startTime.minute).padStart(2, "0")}`}{" "}
                      <span className="text-[0.6em] text-gray-600">
                        {fetchInfo.startTime &&
                          new Intl.DateTimeFormat("en-US", {
                            timeZone: system.displayTimezone ?? undefined,
                            timeZoneName: "short",
                          })
                            .formatToParts(fetchInfo.startTime.toDate())
                            .find((part) => part.type === "timeZoneName")
                            ?.value}
                      </span>
                      {" → "}
                      {fetchInfo.endTime &&
                        `${fetchInfo.endTime.year}-${String(fetchInfo.endTime.month).padStart(2, "0")}-${String(fetchInfo.endTime.day).padStart(2, "0")} ${String(fetchInfo.endTime.hour).padStart(2, "0")}:${String(fetchInfo.endTime.minute).padStart(2, "0")}`}{" "}
                      <span className="text-[0.6em] text-gray-600">
                        {fetchInfo.endTime &&
                          new Intl.DateTimeFormat("en-US", {
                            timeZone: system.displayTimezone ?? undefined,
                            timeZoneName: "short",
                          })
                            .formatToParts(fetchInfo.endTime.toDate())
                            .find((part) => part.type === "timeZoneName")
                            ?.value}
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Heatmap */}
        {selectedPoint && selectedPointInfo && system.displayTimezone ? (
          <HeatmapChart
            systemId={system.id}
            pointPath={selectedPoint}
            pointUnit={selectedPointInfo.metricUnit}
            timezone={system.displayTimezone}
            palette={selectedPalette}
            className="w-full"
            onFetchInfo={setFetchInfo}
          />
        ) : (
          <div className="flex items-center justify-center h-96 bg-gray-900 rounded-lg border border-gray-700">
            <div className="text-gray-400">Select a point to view heatmap</div>
          </div>
        )}
      </div>
    </div>
  );
}
