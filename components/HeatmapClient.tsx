"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import HeatmapChart from "@/components/HeatmapChart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/chart-colors";
import type { ZonedDateTime } from "@internationalized/date";
import { toZoned } from "@internationalized/date";
import { getUnitDisplay } from "@/lib/point/unit-display";
import DashboardHeader from "@/components/DashboardHeader";
import { useUser } from "@clerk/nextjs";

interface PointInfo {
  logicalPath: string;
  physicalPath: string;
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

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface HeatmapClientProps {
  systemIdentifier: string; // For display/routing purposes (can be "1586" or "simon/kinkora")
  systemId: number; // Numeric ID for API calls
}

export default function HeatmapClient({
  systemIdentifier,
  systemId,
}: HeatmapClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useUser();

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [points, setPoints] = useState<PointInfo[]>([]);
  const [availableSystems, setAvailableSystems] = useState<AvailableSystem[]>(
    [],
  );
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

  // Sort points by logical path (used for both menu display and keyboard navigation)
  const sortedPoints = useMemo(
    () =>
      [...points].sort((a, b) => a.logicalPath.localeCompare(b.logicalPath)),
    [points],
  );

  // Helper to update URL parameters
  const updateUrlParams = useCallback(
    (point: string | undefined, palette: HeatmapPaletteKey) => {
      const parts: string[] = [];
      if (point) {
        parts.push(`point=${point}`);
      }
      parts.push(`palette=${palette}`);
      // Use window.history instead of router to avoid Next.js navigation flash
      const newUrl = `${window.location.pathname}?${parts.join("&")}`;
      window.history.replaceState(null, "", newUrl);
    },
    [],
  );

  // Read URL parameters on mount only (not on every searchParams change)
  useEffect(() => {
    const pointParam = searchParams.get("point");
    const paletteParam = searchParams.get("palette");

    if (pointParam) {
      setSelectedPoint(pointParam);
    }
    if (paletteParam && paletteParam in HEATMAP_PALETTES) {
      setSelectedPalette(paletteParam as HeatmapPaletteKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Handle point selection change
  const handlePointChange = useCallback(
    (point: string) => {
      setSelectedPoint(point);
      updateUrlParams(point, selectedPalette);
    },
    [selectedPalette, updateUrlParams],
  );

  // Handle palette selection change
  const handlePaletteChange = useCallback(
    (palette: HeatmapPaletteKey) => {
      setSelectedPalette(palette);
      updateUrlParams(selectedPoint, palette);
    },
    [selectedPoint, updateUrlParams],
  );

  // Fetch system info and points on mount
  useEffect(() => {
    const fetchData = async () => {
      if (!systemId) {
        setError("Invalid system ID");
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        // Fetch points using numeric systemId
        const pointsResponse = await fetch(`/api/system/${systemId}/points`, {
          credentials: "same-origin",
        });

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

        // Fetch system info
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

          // Set available systems from response
          if (systemData.availableSystems) {
            setAvailableSystems(systemData.availableSystems);
          }
        } else {
          // Fallback to default timezone
          setSystem({
            id: systemId,
            displayTimezone: "Australia/Sydney",
            displayName: "System",
          });
        }

        setLoading(false);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    };

    fetchData();
  }, [systemId]);

  // Auto-select first point if none selected
  useEffect(() => {
    if (!selectedPoint && points.length > 0) {
      setSelectedPoint(points[0].logicalPath);
    }
  }, [points, selectedPoint]);

  // Keyboard navigation for points
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if an input/textarea/select is focused
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      // Don't handle if no points or point not selected
      if (!sortedPoints.length || !selectedPoint) {
        return;
      }

      // Find current point index in sorted array
      const currentIndex = sortedPoints.findIndex(
        (p) => p.logicalPath === selectedPoint,
      );
      if (currentIndex === -1) return;

      let newPoint: string | undefined;

      // Left or Up: Previous point
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault(); // Always prevent default scrolling
        if (currentIndex > 0) {
          newPoint = sortedPoints[currentIndex - 1].logicalPath;
        }
      }
      // Right or Down: Next point
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault(); // Always prevent default scrolling
        if (currentIndex < sortedPoints.length - 1) {
          newPoint = sortedPoints[currentIndex + 1].logicalPath;
        }
      }

      // Update selected point
      if (newPoint) {
        handlePointChange(newPoint);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sortedPoints, selectedPoint, handlePointChange]);

  const handleLogout = () => {
    router.push("/sign-in");
  };

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

  const selectedPointInfo = points.find((p) => p.logicalPath === selectedPoint);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200">
      {/* Header */}
      <DashboardHeader
        displayName={`${system.displayName} — Heatmap`}
        systemId={system.id.toString()}
        lastUpdate={null}
        isAdmin={false}
        userId={user?.id}
        availableSystems={availableSystems}
        onLogout={handleLogout}
      />

      <div className="container mx-auto px-4 py-8">
        {/* Controls */}
        <div className="mb-6 flex flex-wrap gap-4">
          {/* Point selector */}
          <div className="flex-1 min-w-[150px] max-w-[250px]">
            <label className="block text-sm text-gray-400 mb-2">
              Select Point
            </label>
            <Select value={selectedPoint} onValueChange={handlePointChange}>
              <SelectTrigger className="bg-gray-900 border-gray-700">
                <SelectValue placeholder="Select a point" />
              </SelectTrigger>
              <SelectContent className="max-h-[500px]">
                {sortedPoints.map((point) => (
                  <SelectItem key={point.reference} value={point.logicalPath}>
                    {point.name} ({point.metricType})
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
                handlePaletteChange(value as HeatmapPaletteKey)
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
                  <td>{system?.displayTimezone}</td>
                </tr>
                <tr>
                  <td className="pr-4 align-top">Physical Path:</td>
                  <td>{selectedPointInfo?.physicalPath}</td>
                </tr>
                <tr>
                  <td className="pr-4 align-top">Logical Path:</td>
                  <td>{selectedPoint}</td>
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
                      <span className="text-gray-600">AEST</span>
                      {" → "}
                      {fetchInfo.endTime &&
                        (() => {
                          const aestEnd = toZoned(fetchInfo.endTime, "+10:00");
                          return `${aestEnd.year}-${String(aestEnd.month).padStart(2, "0")}-${String(aestEnd.day).padStart(2, "0")} ${String(aestEnd.hour).padStart(2, "0")}:${String(aestEnd.minute).padStart(2, "0")}`;
                        })()}{" "}
                      <span className="text-gray-600">AEST</span>
                    </div>
                    <div>
                      {fetchInfo.startTime &&
                        `${fetchInfo.startTime.year}-${String(fetchInfo.startTime.month).padStart(2, "0")}-${String(fetchInfo.startTime.day).padStart(2, "0")} ${String(fetchInfo.startTime.hour).padStart(2, "0")}:${String(fetchInfo.startTime.minute).padStart(2, "0")}`}{" "}
                      <span className="text-gray-600">
                        {fetchInfo.startTime &&
                          system?.displayTimezone &&
                          new Intl.DateTimeFormat("en-US", {
                            timeZone: system.displayTimezone,
                            timeZoneName: "short",
                          })
                            .formatToParts(fetchInfo.startTime.toDate())
                            .find((part) => part.type === "timeZoneName")
                            ?.value}
                      </span>
                      {" → "}
                      {fetchInfo.endTime &&
                        `${fetchInfo.endTime.year}-${String(fetchInfo.endTime.month).padStart(2, "0")}-${String(fetchInfo.endTime.day).padStart(2, "0")} ${String(fetchInfo.endTime.hour).padStart(2, "0")}:${String(fetchInfo.endTime.minute).padStart(2, "0")}`}{" "}
                      <span className="text-gray-600">
                        {fetchInfo.endTime &&
                          system?.displayTimezone &&
                          new Intl.DateTimeFormat("en-US", {
                            timeZone: system.displayTimezone,
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
            pointUnit={getUnitDisplay(selectedPointInfo.metricUnit)}
            metricType={selectedPointInfo.metricType}
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
