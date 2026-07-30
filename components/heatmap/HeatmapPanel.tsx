"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import HeatmapChart from "@/components/HeatmapChart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/heatmap-colors";
import type { ZonedDateTime } from "@internationalized/date";
import { toZoned } from "@internationalized/date";
import { getUnitDisplay } from "@/lib/point/unit-display";

/**
 * The heatmap surface — point selector + palette selector + `HeatmapChart` — with NO URL coupling
 * and all selection state local to this component.
 *
 * Extracted from `components/HeatmapClient.tsx` (which is now just the standalone page's chrome +
 * `?point=`/`?palette=` glue) so the same surface can be mounted more than once on a page, and
 * with either control pinned:
 *
 *  - `pinnedSeries` / `pinnedPalette` override the local selection AND hide the matching `<Select>`;
 *    pin both for a chart-only view. A pinned series that the device doesn't have simply leaves the
 *    chart unmounted (the "select a point" placeholder) rather than feeding an unknown path to the
 *    chart.
 *  - `initialSeries` / `initialPalette` seed the local selection ONCE on mount (matching the
 *    standalone page's read-the-URL-on-mount-only behaviour); `onSelectionChange` fires on USER
 *    changes only — never on the auto-select-first-point — so the page can persist to the URL
 *    without writing one on load.
 */

interface PointListItem {
  logicalPath: string;
  physicalPathTail: string;
  name: string;
  metricType: string;
  metricUnit: string;
  reference: string;
  active: boolean;
}

export interface HeatmapSelection {
  series: string | undefined;
  palette: HeatmapPaletteKey;
}

export interface HeatmapPanelProps {
  systemId: number;
  timezone: string;
  /** Force the series and hide the point selector. */
  pinnedSeries?: string;
  /** Force the palette and hide the palette selector. */
  pinnedPalette?: HeatmapPaletteKey;
  /** Render the fetch-range / path debug table under the controls. */
  showDebug?: boolean;
  /** Bind ←/→/↑/↓ on `window` to step through the device's points. */
  enableKeyboardNav?: boolean;
  initialSeries?: string;
  initialPalette?: HeatmapPaletteKey;
  /** Fired when the USER changes either control; carries the full resulting selection. */
  onSelectionChange?: (selection: HeatmapSelection) => void;
  className?: string;
}

export default function HeatmapPanel({
  systemId,
  timezone,
  pinnedSeries,
  pinnedPalette,
  showDebug = false,
  enableKeyboardNav = false,
  initialSeries,
  initialPalette,
  onSelectionChange,
  className,
}: HeatmapPanelProps) {
  const [selectedPoint, setSelectedPoint] = useState<string | undefined>(
    undefined,
  );
  const [selectedPalette, setSelectedPalette] =
    useState<HeatmapPaletteKey>("viridis");
  const [fetchInfo, setFetchInfo] = useState<{
    interval: string;
    duration: string;
    startTime: ZonedDateTime | null;
    endTime: ZonedDateTime | null;
  } | null>(null);

  // Fetch device points on mount (one-shot)
  const {
    data: pointsData,
    isPending,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: ["system", systemId, "points"],
    queryFn: () =>
      fetchJson<{ points: PointListItem[] }>(`/api/device/${systemId}/points`),
    staleTime: 60_000,
    enabled: !!systemId,
  });

  const points = useMemo<PointListItem[]>(
    () => pointsData?.points ?? [],
    [pointsData],
  );

  // Preserve original loading / error semantics:
  //  - invalid device id  → immediate error
  //  - fetch failure       → derived from the query error
  //  - empty points        → "No points found for this device"
  const loading = !!systemId && isPending;
  let error: string | null = null;
  if (!systemId) {
    error = "Invalid system ID";
  } else if (isError) {
    error =
      queryError instanceof Error
        ? `Failed to fetch points: ${queryError.message}`
        : "Unknown error";
  } else if (pointsData && points.length === 0) {
    error = "No points found for this system";
  }

  // Sort points by logical path (used for both menu display and keyboard navigation)
  const sortedPoints = useMemo(
    () =>
      [...points].sort((a, b) => a.logicalPath.localeCompare(b.logicalPath)),
    [points],
  );

  // Seed from the caller's initial selection on mount only.
  useEffect(() => {
    if (initialSeries) {
      setSelectedPoint(initialSeries);
    }
    if (initialPalette) {
      setSelectedPalette(initialPalette);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Handle point selection change
  const handlePointChange = useCallback(
    (point: string) => {
      setSelectedPoint(point);
      onSelectionChange?.({ series: point, palette: selectedPalette });
    },
    [selectedPalette, onSelectionChange],
  );

  // Handle palette selection change
  const handlePaletteChange = useCallback(
    (palette: HeatmapPaletteKey) => {
      setSelectedPalette(palette);
      onSelectionChange?.({ series: selectedPoint, palette });
    },
    [selectedPoint, onSelectionChange],
  );

  // Auto-select first point if none selected
  useEffect(() => {
    if (!selectedPoint && points.length > 0) {
      setSelectedPoint(points[0].logicalPath);
    }
  }, [points, selectedPoint]);

  // Keyboard navigation for points
  useEffect(() => {
    if (!enableKeyboardNav) return;

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
  }, [enableKeyboardNav, sortedPoints, selectedPoint, handlePointChange]);

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

  if (points.length === 0) {
    return (
      <div className="min-h-screen bg-gray-800 flex items-center justify-center">
        <div className="text-gray-400">No data available</div>
      </div>
    );
  }

  const activePoint = pinnedSeries ?? selectedPoint;
  const activePalette = pinnedPalette ?? selectedPalette;
  const selectedPointInfo = points.find((p) => p.logicalPath === activePoint);
  const showPointSelect = !pinnedSeries;
  const showPaletteSelect = !pinnedPalette;

  return (
    <div className={className}>
      {/* Controls */}
      {(showPointSelect || showPaletteSelect) && (
        <div className="mb-6 flex flex-wrap gap-4">
          {/* Point selector */}
          {showPointSelect && (
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
          )}

          {/* Palette selector */}
          {showPaletteSelect && (
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
          )}
        </div>
      )}

      {/* Debug info */}
      {showDebug && fetchInfo && (
        <div className="mb-4 text-xs text-gray-400">
          <table>
            <tbody>
              <tr>
                <td className="pr-4 align-top">Timezone:</td>
                <td>{timezone}</td>
              </tr>
              <tr>
                <td className="pr-4 align-top">Physical Path:</td>
                <td>{selectedPointInfo?.physicalPathTail}</td>
              </tr>
              <tr>
                <td className="pr-4 align-top">Logical Path:</td>
                <td>{activePoint}</td>
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
                        new Intl.DateTimeFormat("en-US", {
                          timeZone: timezone,
                          timeZoneName: "short",
                        })
                          .formatToParts(fetchInfo.startTime.toDate())
                          .find((part) => part.type === "timeZoneName")?.value}
                    </span>
                    {" → "}
                    {fetchInfo.endTime &&
                      `${fetchInfo.endTime.year}-${String(fetchInfo.endTime.month).padStart(2, "0")}-${String(fetchInfo.endTime.day).padStart(2, "0")} ${String(fetchInfo.endTime.hour).padStart(2, "0")}:${String(fetchInfo.endTime.minute).padStart(2, "0")}`}{" "}
                    <span className="text-gray-600">
                      {fetchInfo.endTime &&
                        new Intl.DateTimeFormat("en-US", {
                          timeZone: timezone,
                          timeZoneName: "short",
                        })
                          .formatToParts(fetchInfo.endTime.toDate())
                          .find((part) => part.type === "timeZoneName")?.value}
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Heatmap */}
      {activePoint && selectedPointInfo && timezone ? (
        <HeatmapChart
          systemId={systemId}
          pointPath={activePoint}
          pointUnit={getUnitDisplay(selectedPointInfo.metricUnit)}
          metricType={selectedPointInfo.metricType}
          timezone={timezone}
          palette={activePalette}
          className="w-full"
          onFetchInfo={setFetchInfo}
        />
      ) : (
        <div className="flex items-center justify-center h-96 bg-gray-900 rounded-lg border border-gray-700">
          <div className="text-gray-400">Select a point to view heatmap</div>
        </div>
      )}
    </div>
  );
}
