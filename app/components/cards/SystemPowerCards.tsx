"use client";

import React from "react";
import PowerCard from "@/components/PowerCard";
import { parsePath } from "@/components/SitePowerChart";
import { LOAD_LABELS } from "@/lib/chart-colors";
import type { LatestPointValues } from "@/lib/types/api";
import { Sun, Home, Battery, Zap } from "lucide-react";

interface SystemPowerCardsProps {
  latest: LatestPointValues;
  vendorType: string;
  secondsSinceUpdate: number;
  getStaleThreshold: (vendorType: string) => number;
  showGrid: boolean;
}

interface LoadPoint {
  path: string;
  value: number;
  label: string;
}

/**
 * Calculate all load values including master, children, and rest-of-house
 *
 * Returns array of LoadPoints with standardized paths (format: type/power).
 * Master load has path "load/power", child loads keep original paths like "load.hvac/power",
 * and rest of house has path "load.OTHER/power".
 *
 * Three calculation cases (matching site data processor logic):
 *
 * Case 1: Master load WITH child loads
 * Uses actual master value from "load/power" point. Children come from "load.subtype/power" points.
 * Rest of House equals master minus sum of children. Total Load for display is the master value.
 * Returns array with master, all children, and restOfHouse (if greater than 0).
 *
 * Case 2: Master load WITHOUT child loads
 * Uses actual master value from "load/power" point. No children exist, so no rest-of-house calculation.
 * Total Load is the master value. Returns array with just the master.
 *
 * Case 3: Child loads WITHOUT master load (sources-based calculation)
 * Synthesizes total load from energy sources: generation plus grid import plus battery discharge.
 * Grid positive means importing (adds to load), battery negative means discharging (adds to load).
 * Formula: totalLoad = generation + max(0, grid) - min(0, battery)
 * Children come from "load.subtype/power" points. Rest of House equals synthesized total minus
 * sum of children. Returns array with synthesized total, all children, and restOfHouse (if greater than 0).
 */
function calculateAllLoads(latest: LatestPointValues): LoadPoint[] {
  let masterLoad: number | null = null;
  const childLoads: LoadPoint[] = [];

  // Iterate through all points in latest to find loads
  Object.entries(latest).forEach(([pointPath, pointData]) => {
    const parsed = (() => {
      try {
        return parsePath(pointPath);
      } catch {
        return null;
      }
    })();

    // Filter for load-type points with power metric
    if (
      parsed &&
      parsed.type === "load" &&
      parsed.metricType === "power" &&
      pointData.value !== null
    ) {
      const value = pointData.value;

      // Master load has no subtype (e.g., "load/power")
      if (!parsed.subtype) {
        masterLoad = value;
      } else {
        // Child load has subtype (e.g., "load.hvac/power", "load.pool/power")
        const loadType = parsed.extension || parsed.subtype || "";
        const label =
          LOAD_LABELS[loadType] ||
          (loadType
            ? loadType.charAt(0).toUpperCase() + loadType.slice(1)
            : "Load");

        childLoads.push({
          path: pointPath,
          value,
          label,
        });
      }
    }
  });

  const allLoads: LoadPoint[] = [];

  // Helper to get point value safely
  const getPointValue = (path: string): number => {
    const point = latest[path];
    return point ? point.value : 0;
  };

  if (masterLoad !== null && childLoads.length > 0) {
    // Case 1: Master load WITH child loads
    allLoads.push({
      path: "load/power",
      value: masterLoad,
      label: "Total Load",
    });

    allLoads.push(...childLoads);

    // Calculate rest-of-house
    const childLoadsSum = childLoads.reduce((sum, load) => sum + load.value, 0);
    const restOfHouse = Math.max(0, masterLoad - childLoadsSum);

    if (restOfHouse > 0) {
      allLoads.push({
        path: "load.OTHER/power",
        value: restOfHouse,
        label: "Rest of House",
      });
    }
  } else if (masterLoad !== null && childLoads.length === 0) {
    // Case 2: Master load WITHOUT child loads
    allLoads.push({
      path: "load/power",
      value: masterLoad,
      label: "Total Load",
    });
  } else if (masterLoad === null && childLoads.length > 0) {
    // Case 3: Child loads WITHOUT master load
    // Synthesize total load from sources: generation + grid import + battery discharge
    // Note: Positive grid = importing, negative battery = discharging (both add to load)

    // Get generation (try source.solar/power first, fallback to sum of local+remote)
    let generation = getPointValue("source.solar/power");
    if (generation === 0) {
      generation =
        getPointValue("source.solar.local/power") +
        getPointValue("source.solar.remote/power");
    }

    const batteryPower = getPointValue("bidi.battery/power");
    const gridPower = getPointValue("bidi.grid/power");

    // Total load = generation + grid (if importing) - battery (if discharging, i.e., negative)
    // When grid is positive, we're importing (adds to load)
    // When battery is negative, we're discharging (adds to load)
    const synthesizedMaster = Math.max(
      0,
      generation + Math.max(0, gridPower) - Math.min(0, batteryPower),
    );

    allLoads.push({
      path: "load/power",
      value: synthesizedMaster,
      label: "Total Load",
    });

    allLoads.push(...childLoads);

    // Calculate rest-of-house from synthesized master
    const childLoadsSum = childLoads.reduce((sum, load) => sum + load.value, 0);
    const restOfHouse = Math.max(0, synthesizedMaster - childLoadsSum);

    if (restOfHouse > 0) {
      allLoads.push({
        path: "load.OTHER/power",
        value: restOfHouse,
        label: "Rest of House",
      });
    }
  }

  // Log the result
  console.log("*** LOAD CALCS", allLoads);

  return allLoads;
}

/**
 * Power cards grid for composite and mondo systems
 * Displays Solar, Load, Battery, and Grid cards in a responsive grid
 */
export default function SystemPowerCards({
  latest,
  vendorType,
  secondsSinceUpdate,
  getStaleThreshold,
  showGrid,
}: SystemPowerCardsProps) {
  // Helper to format power values
  const formatPower = (watts: number) => {
    return `${(watts / 1000).toFixed(1)}\u00A0kW`;
  };

  // Helper to get point value
  const getPointValue = (pointPath: string): number | null => {
    const point = latest[pointPath];
    return point ? point.value : null;
  };

  // Helper to get measurement time
  const getMeasurementTime = (pointPath: string): Date | null => {
    const point = latest[pointPath];
    return point ? point.measurementTime : null;
  };

  // Solar card logic: handle different solar point configurations
  const solarTotal = getPointValue("source.solar/power");
  const solarLocal = getPointValue("source.solar.local/power");
  const solarRemote = getPointValue("source.solar.remote/power");

  const hasBothChildren = solarLocal !== null && solarRemote !== null;
  const hasTotal = solarTotal !== null;

  // Determine solar value to display
  let solarValue: number | null = null;
  if (hasTotal) {
    solarValue = solarTotal;
  } else if (hasBothChildren) {
    solarValue = solarLocal + solarRemote;
  } else if (solarLocal !== null) {
    solarValue = solarLocal;
  } else if (solarRemote !== null) {
    solarValue = solarRemote;
  }

  // Show breakdown if we have total and both children, or if we calculated total from children
  const showBreakdown =
    (hasTotal && hasBothChildren) || (!hasTotal && hasBothChildren);

  // Calculate all loads using the extracted function (memoized to avoid recalculating on every render)
  // Use JSON.stringify for stable dependency since `latest` object reference changes on every data fetch
  const latestJson = JSON.stringify(latest);
  const allLoads = React.useMemo(
    () => calculateAllLoads(latest),
    [latestJson], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Extract total load (first item with path "load/power")
  const masterLoadPoint = allLoads.find((load) => load.path === "load/power");
  const totalLoad = masterLoadPoint ? masterLoadPoint.value : 0;

  // Get display loads (all except master) for showing top 2
  const displayLoads = allLoads.filter((load) => load.path !== "load/power");

  // Sort display loads by value descending and take top 2
  const top2Loads = displayLoads.sort((a, b) => b.value - a.value).slice(0, 2);

  // Battery
  const batterySoc = getPointValue("bidi.battery/soc");
  const batteryPower = getPointValue("bidi.battery/power") || 0;

  // Grid
  const gridPower = getPointValue("bidi.grid/power") || 0;

  // Determine if we should show the load card
  const hasLoadData = allLoads.length > 0;

  // Count how many cards will be displayed
  const cardCount = [
    solarValue !== null,
    hasLoadData,
    batterySoc !== null,
    showGrid && getPointValue("bidi.grid/power") !== null,
  ].filter(Boolean).length;

  // Determine grid columns - never more columns than cards
  const getGridClass = () => {
    if (cardCount === 1) return "grid-cols-1";
    if (cardCount === 2) return "grid-cols-2";
    if (cardCount === 3) return "grid-cols-3";
    if (cardCount === 4) return "grid-cols-4";
    if (cardCount === 5) return "grid-cols-4 lg:grid-cols-5";
    // 6+ cards
    return "grid-cols-4 lg:grid-cols-6";
  };

  return (
    <div className="mb-4 px-1">
      <div className={`grid gap-2 lg:gap-4 ${getGridClass()}`}>
        {/* Solar Card */}
        {solarValue !== null && (
          <PowerCard
            title="Solar"
            value={formatPower(solarValue)}
            icon={<Sun className="w-6 h-6" />}
            iconColor="text-yellow-400"
            bgColor="bg-yellow-900/20"
            borderColor="border-yellow-700"
            secondsSinceUpdate={secondsSinceUpdate}
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={
              getMeasurementTime("source.solar/power") ||
              getMeasurementTime("source.solar.local/power") ||
              getMeasurementTime("source.solar.remote/power") ||
              undefined
            }
            extra={
              showBreakdown ? (
                <div className="text-xs text-gray-400 space-y-0.5">
                  {solarLocal !== null && (
                    <div>Local: {formatPower(solarLocal)}</div>
                  )}
                  {solarRemote !== null && (
                    <div>Remote: {formatPower(solarRemote)}</div>
                  )}
                </div>
              ) : undefined
            }
          />
        )}

        {/* Load Card */}
        {hasLoadData && (
          <PowerCard
            title="Load"
            value={formatPower(totalLoad)}
            icon={<Home className="w-6 h-6" />}
            iconColor="text-blue-400"
            bgColor="bg-blue-900/20"
            borderColor="border-blue-700"
            secondsSinceUpdate={secondsSinceUpdate}
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={getMeasurementTime("load/power") || undefined}
            extra={
              top2Loads.length > 0 ? (
                <div className="text-xs text-gray-400 space-y-0.5">
                  {top2Loads.map((load) => (
                    <div key={load.path}>
                      {load.label}: {formatPower(load.value)}
                    </div>
                  ))}
                </div>
              ) : undefined
            }
          />
        )}

        {/* Battery Card */}
        {batterySoc !== null && (
          <PowerCard
            title="Battery"
            value={`${batterySoc.toFixed(1)}%`}
            icon={<Battery className="w-6 h-6" />}
            iconColor={
              batteryPower < 0
                ? "text-green-400"
                : batteryPower > 0
                  ? "text-orange-400"
                  : "text-gray-400"
            }
            bgColor={
              batteryPower < 0
                ? "bg-green-900/20"
                : batteryPower > 0
                  ? "bg-orange-900/20"
                  : "bg-gray-900/20"
            }
            borderColor={
              batteryPower < 0
                ? "border-green-700"
                : batteryPower > 0
                  ? "border-orange-700"
                  : "border-gray-700"
            }
            secondsSinceUpdate={secondsSinceUpdate}
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={
              getMeasurementTime("bidi.battery/soc") || undefined
            }
            extraInfo={
              batteryPower !== 0
                ? `${batteryPower < 0 ? "Charging" : "Discharging"} ${formatPower(Math.abs(batteryPower))}`
                : "Idle"
            }
          />
        )}

        {/* Grid Card */}
        {showGrid && getPointValue("bidi.grid/power") !== null && (
          <PowerCard
            title="Grid"
            value={formatPower(gridPower)}
            icon={<Zap className="w-6 h-6" />}
            iconColor={
              gridPower > 0
                ? "text-red-400"
                : gridPower < 0
                  ? "text-green-400"
                  : "text-gray-400"
            }
            bgColor={
              gridPower > 0
                ? "bg-red-900/20"
                : gridPower < 0
                  ? "bg-green-900/20"
                  : "bg-gray-900/20"
            }
            borderColor={
              gridPower > 0
                ? "border-red-700"
                : gridPower < 0
                  ? "border-green-700"
                  : "border-gray-700"
            }
            secondsSinceUpdate={secondsSinceUpdate}
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={getMeasurementTime("bidi.grid/power") || undefined}
            extraInfo={
              gridPower > 0
                ? "Importing"
                : gridPower < 0
                  ? "Exporting"
                  : "Neutral"
            }
          />
        )}
      </div>
    </div>
  );
}
