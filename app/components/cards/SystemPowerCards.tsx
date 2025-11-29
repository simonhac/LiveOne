"use client";

import React from "react";
import PowerCard from "@/components/PowerCard";
import AmberSmallCard from "@/components/AmberSmallCard";
import { stemSplit, getMetricType } from "@/lib/identifiers/logical-path";
import type { LatestPointValues, LatestPointValue } from "@/lib/types/api";
import {
  Sun,
  Home,
  Battery,
  Zap,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

interface SystemPowerCardsProps {
  latest: LatestPointValues;
  vendorType: string;
  getStaleThreshold: (vendorType: string) => number;
  showGrid: boolean;
  /** Layout mode: "horizontal" for full-width row, "sidebar" for vertical stack on desktop */
  layout?: "horizontal" | "sidebar";
  /** Additional CSS classes for the outer container */
  className?: string;
}

interface LoadPoint {
  path: string;
  value: number;
  label: string;
}

/**
 * Generate flow direction chevron for bidirectional power sources
 * @param powerWatts - Power value in watts (sign determines direction)
 * @param isIntoSource - true if power flows INTO the source (charge/export)
 * @param colorClass - Tailwind color class to match the icon
 * @returns React node with chevron(s) or null if |power| < 100W
 */
function getFlowChevron(
  powerWatts: number,
  isIntoSource: boolean,
  colorClass: string,
): React.ReactNode {
  const absPower = Math.abs(powerWatts);

  // No chevron for < 100W
  if (absPower < 100) {
    return null;
  }

  const isDouble = absPower > 5000;

  // Desktop: chevrons left of icon, so INTO = right arrow, OUT = left arrow
  // Mobile: chevrons right of icon, so INTO = left arrow, OUT = right arrow (reversed)

  if (isIntoSource) {
    // Power flowing INTO the source (charge battery / export to grid)
    return (
      <>
        {/* Mobile: chevrons on right of icon, point left (into icon on left) */}
        <span className={`${colorClass} md:hidden`}>
          {isDouble ? (
            <ChevronsLeft className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </span>
        {/* Desktop: chevrons on left of icon, point right (into icon on right) */}
        <span className={`${colorClass} hidden md:block`}>
          {isDouble ? (
            <ChevronsRight className="w-5 h-5" />
          ) : (
            <ChevronRight className="w-5 h-5" />
          )}
        </span>
      </>
    );
  } else {
    // Power flowing OUT of the source (discharge battery / import from grid)
    return (
      <>
        {/* Mobile: chevrons on right of icon, point right (away from icon on left) */}
        <span className={`${colorClass} md:hidden`}>
          {isDouble ? (
            <ChevronsRight className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </span>
        {/* Desktop: chevrons on left of icon, point left (away from icon on right) */}
        <span className={`${colorClass} hidden md:block`}>
          {isDouble ? (
            <ChevronsLeft className="w-5 h-5" />
          ) : (
            <ChevronLeft className="w-5 h-5" />
          )}
        </span>
      </>
    );
  }
}

/**
 * Synthesize rest of house load point from master minus child loads
 * Creates a LatestPointValue with timestamp = max of master + all child loads
 */
function synthesizeRestOfHouse(
  latest: LatestPointValues,
): LatestPointValue | null {
  // Get master load
  const masterLoad = latest["load/power"];
  if (!masterLoad) {
    return null;
  }

  // Find all child loads (paths like "load.hvac/power", "load.pool/power")
  const childLoads: {
    value: number;
    measurementTime: Date;
  }[] = [];
  for (const [path, point] of Object.entries(latest)) {
    if (
      path.startsWith("load.") &&
      path.endsWith("/power") &&
      point.value !== null
    ) {
      childLoads.push({
        value: point.value,
        measurementTime: point.measurementTime,
      });
    }
  }

  // Only calculate rest of house if we have child loads
  if (childLoads.length === 0) {
    return null;
  }

  // Calculate rest of house value
  const childSum = childLoads.reduce((sum, load) => sum + load.value, 0);
  const restOfHouseValue = Math.max(0, masterLoad.value - childSum);

  // Only create rest of house if > 0
  if (restOfHouseValue <= 0) {
    return null;
  }

  // Find most recent measurementTime from master and all child loads
  const maxMeasurementTime = childLoads.reduce(
    (max, child) => (child.measurementTime > max ? child.measurementTime : max),
    masterLoad.measurementTime,
  );

  return {
    value: restOfHouseValue,
    logicalPath: "load.OTHER/power",
    measurementTime: maxMeasurementTime,
    metricUnit: "W",
    displayName: "Other",
  };
}

/**
 * Synthesize master load point from energy balance if it doesn't exist
 * Creates a LatestPointValue with proper timestamp from source points
 */
function synthesizeMasterLoad(
  latest: LatestPointValues,
): LatestPointValue | null {
  // Only synthesize if master load doesn't already exist
  if (latest["load/power"]) {
    return null;
  }

  // Helper to get point value
  const getValue = (path: string): number => {
    const point = latest[path];
    return point?.value ?? 0;
  };

  // Helper to get measurement time
  const getTime = (path: string): Date | null => {
    const point = latest[path];
    return point?.measurementTime ?? null;
  };

  // Get generation (try source.solar/power first, fallback to sum of local+remote)
  let generation = getValue("source.solar/power");
  if (generation === 0) {
    generation =
      getValue("source.solar.local/power") +
      getValue("source.solar.remote/power");
  }

  const batteryPower = getValue("bidi.battery/power");
  const gridPower = getValue("bidi.grid/power");

  // Only synthesize if we have at least one source of data
  if (generation === 0 && batteryPower === 0 && gridPower === 0) {
    return null;
  }

  // Calculate synthesized load: Solar + Battery + Grid = Load
  // Sign conventions: Battery positive = discharge, Grid positive = import
  const synthesizedValue = Math.max(0, generation + batteryPower + gridPower);

  // Find most recent timestamp from all source points
  const sourcePaths = [
    "source.solar/power",
    "source.solar.local/power",
    "source.solar.remote/power",
    "bidi.battery/power",
    "bidi.grid/power",
  ];

  let maxTime: Date | null = null;
  for (const path of sourcePaths) {
    const time = getTime(path);
    if (time && (!maxTime || time > maxTime)) {
      maxTime = time;
    }
  }

  // If no timestamp found, use current time
  if (!maxTime) {
    maxTime = new Date();
  }

  return {
    value: synthesizedValue,
    logicalPath: "load/power",
    measurementTime: maxTime,
    metricUnit: "W",
    displayName: "Load",
  };
}

/**
 * Calculate all load values including master, children, and rest-of-house
 *
 * Returns array of LoadPoints with standardized paths (format: type/power).
 * Master load has path "load/power", child loads keep original paths like "load.hvac/power",
 * and rest of house has path "load.OTHER/power".
 *
 * Note: Expects master load to exist in latest (either real or synthesized).
 * Call synthesizeMasterLoad() first if needed.
 *
 * Two calculation cases:
 *
 * Case 1: Master load WITH child loads
 * Uses master value from "load/power" point. Children come from "load.subtype/power" points.
 * Rest of House equals master minus sum of children. Total Load for display is the master value.
 * Returns array with master, all children, and restOfHouse (if greater than 0).
 *
 * Case 2: Master load WITHOUT child loads
 * Uses master value from "load/power" point. No children exist, so no rest-of-house calculation.
 * Total Load is the master value. Returns array with just the master.
 */
function calculateAllLoads(latest: LatestPointValues): LoadPoint[] {
  let masterLoad: number | null = null;
  const childLoads: LoadPoint[] = [];

  // Iterate through all points in latest to find loads
  Object.entries(latest).forEach(([pointPath, pointData]) => {
    const segments = stemSplit(pointPath);
    const metricType = getMetricType(pointPath);

    // Filter for load-type points with power metric
    if (
      segments[0] === "load" &&
      metricType === "power" &&
      pointData.value !== null
    ) {
      const value = pointData.value;

      // Master load has no subtype (e.g., "load/power")
      if (segments.length === 1) {
        masterLoad = value;
      } else {
        // Child load has subtype (e.g., "load.hvac/power", "load.pool/power")
        // Use displayName from point metadata, falling back to path-derived label
        const loadType = segments.slice(1).join(".") || "";
        const label =
          pointData.displayName ||
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
        label: "Other",
      });
    }
  } else if (masterLoad !== null && childLoads.length === 0) {
    // Case 2: Master load WITHOUT child loads
    allLoads.push({
      path: "load/power",
      value: masterLoad,
      label: "Total Load",
    });
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
  getStaleThreshold,
  showGrid,
  layout = "horizontal",
  className,
}: SystemPowerCardsProps) {
  // Helper to format power value (number only, no unit)
  const formatPowerValue = (watts: number) => {
    return (watts / 1000).toFixed(1);
  };

  // Helper to format power with smaller unit (JSX for secondary labels)
  const formatPowerSmallUnit = (watts: number) => {
    return (
      <>
        {formatPowerValue(watts)}
        {"\u202F"}
        <span className="text-[0.7em]">kW</span>
      </>
    );
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

  // Synthesize master load and rest of house if needed
  // This creates LatestPointValue objects with proper timestamps
  const enrichedLatest = React.useMemo(() => {
    let enriched = { ...latest };

    // First synthesize master load if needed
    const synthesizedLoad = synthesizeMasterLoad(enriched);
    if (synthesizedLoad) {
      enriched = {
        ...enriched,
        "load/power": synthesizedLoad,
      };
    }

    // Then synthesize rest of house if applicable
    const synthesizedRestOfHouse = synthesizeRestOfHouse(enriched);
    if (synthesizedRestOfHouse) {
      enriched = {
        ...enriched,
        "load.OTHER/power": synthesizedRestOfHouse,
      };
    }

    return enriched;
  }, [latest]);

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

  // Calculate all loads using enriched latest (with synthesized load if needed)
  // Use JSON.stringify for stable dependency since object reference changes on every data fetch
  const latestJson = JSON.stringify(enrichedLatest);
  const allLoads = React.useMemo(
    () => calculateAllLoads(enrichedLatest),
    [latestJson], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Extract total load (first item with path "load/power")
  const masterLoadPoint = allLoads.find((load) => load.path === "load/power");
  const totalLoad = masterLoadPoint ? masterLoadPoint.value : 0;

  // Get display loads (all except master) for showing top 2
  const displayLoads = allLoads.filter((load) => load.path !== "load/power");

  // Sort display loads by value descending, filter out < 100W, and take top 2
  const top2Loads = displayLoads
    .filter((load) => load.value >= 100) // Only show loads >= 0.1kW
    .sort((a, b) => b.value - a.value)
    .slice(0, 2);

  // Get the most recent measurement time across all load points
  // For composite systems, child loads may have different timestamps
  // For synthesized loads (Case 3/4), also check source point timestamps
  const loadMeasurementTime = React.useMemo(() => {
    let maxTime: Date | null = null;

    // Check all load points (including master and children)
    for (const load of allLoads) {
      const time = getMeasurementTime(load.path);
      if (time && (!maxTime || time > maxTime)) {
        maxTime = time;
      }
    }

    // If load was synthesized (no actual "load/power" point exists),
    // also check timestamps from source points used in calculation
    if (!latest["load/power"]) {
      const sourcePaths = [
        "source.solar/power",
        "source.solar.local/power",
        "source.solar.remote/power",
        "bidi.battery/power",
        "bidi.grid/power",
      ];

      for (const path of sourcePaths) {
        const time = getMeasurementTime(path);
        if (time && (!maxTime || time > maxTime)) {
          maxTime = time;
        }
      }
    }

    return maxTime;
  }, [allLoads, latest, getMeasurementTime]);

  // Battery
  const batterySoc = getPointValue("bidi.battery/soc");
  const batteryPower = getPointValue("bidi.battery/power") || 0;

  // Grid
  const gridPower = getPointValue("bidi.grid/power") || 0;

  // Check if Amber pricing data is available
  const hasAmberData = getPointValue("bidi.grid.import/rate") !== null;

  // Determine if we should show the load card
  const hasLoadData = allLoads.length > 0;

  // Count how many cards will be displayed
  const cardCount = [
    solarValue !== null,
    hasLoadData,
    batterySoc !== null,
    showGrid && getPointValue("bidi.grid/power") !== null,
    hasAmberData,
  ].filter(Boolean).length;

  // Determine grid columns based on layout mode
  const getGridClass = () => {
    if (layout === "sidebar") {
      // Sidebar: horizontal on mobile, vertical stack on desktop
      if (cardCount === 1) return "grid-cols-1";
      if (cardCount === 2) return "grid-cols-2 lg:grid-cols-1";
      if (cardCount === 3) return "grid-cols-3 lg:grid-cols-1";
      return "grid-cols-4 lg:grid-cols-1";
    }
    // Horizontal: dynamic columns based on card count
    if (cardCount === 1) return "grid-cols-1";
    if (cardCount === 2) return "grid-cols-2";
    if (cardCount === 3) return "grid-cols-3";
    if (cardCount === 4) return "grid-cols-4";
    if (cardCount === 5) return "grid-cols-3";
    // 6+ cards
    return "grid-cols-4 lg:grid-cols-6";
  };

  return (
    <div
      className={`px-1 ${layout === "sidebar" ? "h-full" : "mb-4"} ${className || ""}`}
    >
      <div
        className={`grid gap-2 lg:gap-4 ${getGridClass()} ${layout === "sidebar" ? "h-full lg:content-between" : ""}`}
      >
        {/* Solar Card */}
        {solarValue !== null && (
          <PowerCard
            title="Solar"
            value={formatPowerValue(solarValue)}
            unit="kW"
            icon={<Sun className="w-6 h-6" />}
            iconColor="text-yellow-400"
            bgColor="bg-yellow-900/20"
            borderColor="border-yellow-700"
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
                    <div>Local: {formatPowerSmallUnit(solarLocal)}</div>
                  )}
                  {solarRemote !== null && (
                    <div>Remote: {formatPowerSmallUnit(solarRemote)}</div>
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
            value={formatPowerValue(totalLoad)}
            unit="kW"
            icon={<Home className="w-6 h-6" />}
            iconColor="text-blue-400"
            bgColor="bg-blue-900/20"
            borderColor="border-blue-700"
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={loadMeasurementTime || undefined}
            extra={
              top2Loads.length > 0 ? (
                <div className="text-xs text-gray-400 space-y-0.5">
                  {top2Loads.map((load) => (
                    <div key={load.path}>
                      {load.label}: {formatPowerSmallUnit(load.value)}
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
            value={batterySoc.toFixed(1)}
            unit="%"
            icon={
              <span className="inline-flex items-center h-6 flex-row-reverse md:flex-row">
                {getFlowChevron(
                  batteryPower,
                  batteryPower < 0, // negative = charging = into battery
                  batteryPower < 0
                    ? "text-green-400"
                    : batteryPower > 0
                      ? "text-orange-400"
                      : "text-gray-400",
                )}
                <Battery className="w-6 h-6" />
              </span>
            }
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
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={
              getMeasurementTime("bidi.battery/soc") || undefined
            }
            extra={
              Math.abs(batteryPower) >= 100 ? (
                <div className="text-xs text-gray-400">
                  {batteryPower < 0 ? "Charging" : "Discharging"}{" "}
                  {formatPowerSmallUnit(Math.abs(batteryPower))}
                </div>
              ) : (
                <div className="text-xs text-gray-400">Idle</div>
              )
            }
          />
        )}

        {/* Grid Card */}
        {showGrid && getPointValue("bidi.grid/power") !== null && (
          <PowerCard
            title="Grid"
            value={
              Math.abs(gridPower) < 100
                ? "Neutral"
                : formatPowerValue(Math.abs(gridPower))
            }
            unit={Math.abs(gridPower) < 100 ? undefined : "kW"}
            icon={
              <span className="inline-flex items-center h-6 flex-row-reverse md:flex-row">
                {getFlowChevron(
                  gridPower,
                  gridPower < 0, // negative = exporting = into grid
                  gridPower >= 100
                    ? "text-red-400"
                    : gridPower <= -100
                      ? "text-green-400"
                      : "text-gray-400",
                )}
                <Zap className="w-6 h-6" />
              </span>
            }
            iconColor={
              gridPower >= 100
                ? "text-red-400"
                : gridPower <= -100
                  ? "text-green-400"
                  : "text-gray-400"
            }
            bgColor={
              gridPower >= 100
                ? "bg-red-900/20"
                : gridPower <= -100
                  ? "bg-green-900/20"
                  : "bg-gray-900/20"
            }
            borderColor={
              gridPower >= 100
                ? "border-red-700"
                : gridPower <= -100
                  ? "border-green-700"
                  : "border-gray-700"
            }
            staleThresholdSeconds={getStaleThreshold(vendorType)}
            measurementTime={getMeasurementTime("bidi.grid/power") || undefined}
            extraInfo={
              gridPower >= 100
                ? "Importing"
                : gridPower <= -100
                  ? "Exporting"
                  : undefined
            }
          />
        )}

        {/* Amber Pricing Card - only show if Amber data available */}
        {hasAmberData && <AmberSmallCard latest={latest} />}
      </div>
    </div>
  );
}
