"use client";

/**
 * Shared tile derivations — the cross-tile synthesis/formatting helpers that used to live inside
 * `useTileNodes` (dismantled into per-view plugins). All pure functions over `latest`; no hooks.
 */
import React from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { stemSplit, getMetricType } from "@/lib/identifiers/logical-path";
import type { LatestPointValues, LatestPointValue } from "@/lib/types/api";

export interface LoadPoint {
  path: string;
  value: number;
  label: string;
}

/** Format a power value in kW (number only, no unit). */
export function formatPowerValue(watts: number): string {
  return (watts / 1000).toFixed(1);
}

/** Format a power value with a smaller kW unit (JSX for secondary labels). */
export function formatPowerSmallUnit(watts: number): React.ReactNode {
  return (
    <>
      {formatPowerValue(watts)} <span className="text-[0.7em]">kW</span>
    </>
  );
}

export function getPointValue(
  latest: LatestPointValues,
  pointPath: string,
): number | null {
  const point = latest[pointPath];
  return point ? point.value : null;
}

export function getMeasurementTime(
  latest: LatestPointValues,
  pointPath: string,
): Date | null {
  const point = latest[pointPath];
  return point ? point.measurementTime : null;
}

/**
 * Generate flow direction chevron for bidirectional power sources
 * @param powerWatts - Power value in watts (sign determines direction)
 * @param isIntoSource - true if power flows INTO the source (charge/export)
 * @param colorClass - Tailwind color class to match the icon
 * @returns React node with chevron(s) or null if |power| < 100W
 */
export function getFlowChevron(
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
export function synthesizeRestOfHouse(
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
    logicalPath: "load.rest-of-house/power",
    measurementTime: maxMeasurementTime,
    metricUnit: "W",
    displayName: "Other",
  };
}

/**
 * Synthesize master load point from energy balance if it doesn't exist
 * Creates a LatestPointValue with proper timestamp from source points
 */
export function synthesizeMasterLoad(
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
 * Enrich `latest` with the synthesized master-load / rest-of-house points (when missing). The load
 * tile renders from this enriched map; every other tile reads the raw `latest`.
 */
export function enrichLatest(latest: LatestPointValues): LatestPointValues {
  let enriched = { ...latest };

  const synthesizedLoad = synthesizeMasterLoad(enriched);
  if (synthesizedLoad) {
    enriched = {
      ...enriched,
      "load/power": synthesizedLoad,
    };
  }

  const synthesizedRestOfHouse = synthesizeRestOfHouse(enriched);
  if (synthesizedRestOfHouse) {
    enriched = {
      ...enriched,
      "load.rest-of-house/power": synthesizedRestOfHouse,
    };
  }

  return enriched;
}

/**
 * Calculate all load values including master, children, and rest-of-house.
 * (See the original SystemTiles docblock for the two calculation cases.)
 */
export function calculateAllLoads(latest: LatestPointValues): LoadPoint[] {
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
        path: "load.rest-of-house/power",
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

  return allLoads;
}
