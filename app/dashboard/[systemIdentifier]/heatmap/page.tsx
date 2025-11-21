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
  const [selectedPoint, setSelectedPoint] = useState<string>("");
  const [selectedPalette, setSelectedPalette] =
    useState<HeatmapPaletteKey>("viridis");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="min-h-screen bg-gray-800 text-gray-200">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">
            {system.displayName} - Heatmap
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
                    {point.name} ({point.metricUnit})
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
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(HEATMAP_PALETTES).map(([key, config]) => (
                  <SelectItem key={key} value={key}>
                    {config.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500 mt-1">
              {HEATMAP_PALETTES[selectedPalette].description}
            </p>
          </div>
        </div>

        {/* Heatmap */}
        {selectedPoint && selectedPointInfo && (
          <HeatmapChart
            systemId={system.id}
            pointPath={selectedPoint}
            pointUnit={selectedPointInfo.metricUnit}
            timezone={system.displayTimezone || "Australia/Sydney"}
            palette={selectedPalette}
            className="w-full"
          />
        )}
      </div>
    </div>
  );
}
