"use client";

import React from "react";
import { Home } from "lucide-react";
import Tile from "@/components/Tile";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  calculateAllLoads,
  enrichLatest,
  formatPowerValue,
  formatPowerSmallUnit,
  getMeasurementTime,
} from "./shared";

/**
 * The Load tile. Renders from the ENRICHED latest (master load synthesized from the energy balance
 * when no `load/power` point exists, plus a rest-of-house child) — the one tile coupled to the
 * solar/battery/grid raw points through that synthesis.
 */
function LoadTile({ latest, staleThresholdSeconds }: TileRenderProps) {
  // Synthesize master load and rest of house if needed
  const enrichedLatest = React.useMemo(() => enrichLatest(latest), [latest]);

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

    // Read times from the RAW latest: synthesized paths (master/rest-of-house) contribute nothing
    // here — the sourcePaths branch below covers the synthesized-master case.
    for (const load of allLoads) {
      const time = getMeasurementTime(latest, load.path);
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
        const time = getMeasurementTime(latest, path);
        if (time && (!maxTime || time > maxTime)) {
          maxTime = time;
        }
      }
    }

    return maxTime;
  }, [allLoads, latest]);

  return (
    <Tile
      title="Load"
      value={formatPowerValue(totalLoad)}
      unit="kW"
      icon={<Home className="w-6 h-6" />}
      iconColor="text-blue-400"
      bgColor="bg-blue-900/20"
      borderColor="border-blue-700"
      staleThresholdSeconds={staleThresholdSeconds}
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
  );
}

export const loadTile: TilePlugin = {
  view: "load",
  isAvailable: ({ latest }) =>
    calculateAllLoads(enrichLatest(latest)).length > 0,
  Render: LoadTile,
};
