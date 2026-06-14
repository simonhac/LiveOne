"use client";

import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Tile from "@/components/Tile";
import AmberSmallCard from "@/components/AmberSmallCard";
import TeslaSmallCard from "@/components/TeslaSmallCard";
import HwsSmallCard from "@/components/HwsSmallCard";
import { historyQuery } from "@/lib/queries";
import { DEFAULT_HWS_MODEL_OPTIONS } from "@/lib/hws-model";
import { stemSplit, getMetricType } from "@/lib/identifiers/logical-path";
import type { TileId } from "@/lib/dashboard/cards";
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

/**
 * Shared builder for the tiles (solar/load/battery/grid/amber/ev).
 *
 * Extracted from SystemTiles so BOTH the live dashboard and the Customize dialog render the
 * EXACT same card nodes — the dialog shows cards "as they actually would" on the dashboard. The
 * hook owns all the synthesis/aggregation; the caller owns ordering + grid layout.
 *
 * Returns:
 *  - `available`: which cards have data (the authoritative availability)
 *  - `cardNodes`: each card's rendered node, keyed by id (built for all ids; the caller picks order/subset)
 */
export interface UseTileNodesArgs {
  latest: LatestPointValues;
  vendorType: string;
  getStaleThreshold: (vendorType: string) => number;
  showGrid: boolean;
  systemId?: number;
  canControl?: boolean;
}

export interface TileNodes {
  available: Record<TileId, boolean>;
  cardNodes: Record<TileId, React.ReactNode>;
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
 * Calculate all load values including master, children, and rest-of-house.
 * (See the original SystemTiles docblock for the two calculation cases.)
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

/**
 * Build the per-id tile nodes + availability for a system's latest values.
 */
export function useTileNodes({
  latest,
  vendorType,
  getStaleThreshold,
  showGrid,
  systemId,
  canControl,
}: UseTileNodesArgs): TileNodes {
  // Helper to format power value (number only, no unit)
  const formatPowerValue = (watts: number) => {
    return (watts / 1000).toFixed(1);
  };

  // Helper to format power with smaller unit (JSX for secondary labels)
  const formatPowerSmallUnit = (watts: number) => {
    return (
      <>
        {formatPowerValue(watts)}
        {" "}
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
  const enrichedLatest = React.useMemo(() => {
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
  }, [latest]);

  // Solar card logic: handle different solar point configurations
  const solarTotal = getPointValue("source.solar/power");
  const solarLocal = getPointValue("source.solar.local/power");
  const solarRemote = getPointValue("source.solar.remote/power");

  const hasBothChildren = solarLocal !== null && solarRemote !== null;
  const hasTotal = solarTotal !== null;

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

  const showBreakdown =
    (hasTotal && hasBothChildren) || (!hasTotal && hasBothChildren);

  // Calculate all loads using enriched latest (with synthesized load if needed)
  const latestJson = JSON.stringify(enrichedLatest);
  const allLoads = React.useMemo(
    () => calculateAllLoads(enrichedLatest),
    [latestJson], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const masterLoadPoint = allLoads.find((load) => load.path === "load/power");
  const totalLoad = masterLoadPoint ? masterLoadPoint.value : 0;

  const displayLoads = allLoads.filter((load) => load.path !== "load/power");

  const top2Loads = displayLoads
    .filter((load) => load.value >= 100)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2);

  const loadMeasurementTime = React.useMemo(() => {
    let maxTime: Date | null = null;

    for (const load of allLoads) {
      const time = getMeasurementTime(load.path);
      if (time && (!maxTime || time > maxTime)) {
        maxTime = time;
      }
    }

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

  // Check if Tesla EV data is available
  const hasTeslaData = getPointValue("ev.battery/soc") !== null;

  // Determine if we should show the load card
  const hasLoadData = allLoads.length > 0;

  // Which tiles have data (the authoritative availability).
  const hwsTemp = getPointValue("load.hws/temperature");

  // HWS 24h sparkline — fetched here (orchestrated) so HwsSmallCard stays presentational like the
  // other mini-cards. Uses the generic /api/history query; multiple useTileNodes callers share
  // one request via the query key. Only fires when there is HWS temperature data.
  const hwsHistory = useQuery(
    historyQuery({
      systemId: systemId ?? "",
      interval: "5m",
      last: "24h",
      series: "load.hws/temperature.avg",
      enabled: systemId != null && hwsTemp != null,
    }),
  );
  const hwsSparkValues = useMemo<number[]>(() => {
    const series = (
      hwsHistory.data as { data?: Array<{ history?: { data?: unknown[] } }> }
    )?.data?.[0]?.history?.data;
    if (!Array.isArray(series)) return [];
    return series.filter((v: unknown): v is number => typeof v === "number");
  }, [hwsHistory.data]);

  const available: Record<TileId, boolean> = {
    solar: solarValue !== null,
    load: hasLoadData,
    hotWater: hwsTemp !== null,
    battery: batterySoc !== null,
    grid: showGrid && getPointValue("bidi.grid/power") !== null,
    amber: hasAmberData,
    ev: hasTeslaData,
  };

  // Each mini-card's node, keyed by id, so the dashboard/dialog can render them in any order/subset.
  const cardNodes: Record<TileId, React.ReactNode> = {
    solar: (
      <Tile
        title="Solar"
        value={formatPowerValue(solarValue ?? 0)}
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
    ),
    load: (
      <Tile
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
    ),
    battery: (
      <Tile
        title="Battery"
        value={(batterySoc ?? 0).toFixed(1)}
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
        measurementTime={getMeasurementTime("bidi.battery/soc") || undefined}
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
    ),
    grid: (
      <Tile
        title="Grid"
        value={
          Math.abs(gridPower) < 100
            ? "Idle"
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
    ),
    amber: <AmberSmallCard latest={latest} />,
    ev: (
      <TeslaSmallCard
        latest={latest}
        systemId={systemId}
        canControl={canControl}
      />
    ),
    hotWater: (
      <HwsSmallCard
        faucetC={hwsTemp}
        sparkValues={hwsSparkValues}
        measurementTime={
          getMeasurementTime("load.hws/temperature") ?? undefined
        }
        heating={
          (getPointValue("load.hws/power") ?? 0) >
          DEFAULT_HWS_MODEL_OPTIONS.onThresholdW
        }
        staleThresholdSeconds={getStaleThreshold(vendorType)}
      />
    ),
  };

  return { available, cardNodes };
}
