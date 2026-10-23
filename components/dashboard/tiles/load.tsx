"use client";

import React from "react";
import { Home } from "lucide-react";
import Tile from "@/components/Tile";
import { CHART_COLORS, getColorForPath } from "@/lib/chart-colors";
import { REST_OF_HOUSE_PATH } from "@/lib/areas/derived-display-paths";
import { ROLE_CHROME } from "@/lib/role-chrome";
import { pickLoad, useSiteBars } from "./use-site-bars";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  calculateAllLoads,
  enrichLatest,
  formatPowerValue,
  getMeasurementTime,
  TileBars,
  TileBreakdown,
} from "./shared";

/**
 * The Load tile. Renders from the ENRICHED latest (master load synthesized from the energy balance
 * when no `load/power` point exists, plus a rest-of-house child) — the one tile coupled to the
 * solar/battery/grid raw points through that synthesis.
 */
function LoadTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const { bars, pending: barsPending } = useSiteBars(systemId, pickLoad);
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
      icon={<Home />}
      tone={ROLE_CHROME.load.value}
      label="Now"
      value={formatPowerValue(totalLoad)}
      unit="kW"
      valueColor={ROLE_CHROME.load.value}
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={loadMeasurementTime || undefined}
      extra={
        top2Loads.length > 0 || bars.length > 0 || barsPending ? (
          <>
            {/* The two biggest sub-loads, each value in ITS OWN series colour — the same colour
                its band has in the stacked chart, so the tile names the band. */}
            <TileBreakdown
              rows={top2Loads.map((load) => ({
                key: load.path,
                label: load.label,
                watts: load.value,
                color: loadColour(load.path),
              }))}
            />
            <TileBars
              bars={bars}
              pending={barsPending}
              color={ROLE_CHROME.load.rgb}
              ariaLabel="Household load over the period"
            />
          </>
        ) : undefined
      }
    />
  );
}

/** A child load's series colour, as the stacked chart draws it. */
function loadColour(path: string): string {
  return path === REST_OF_HOUSE_PATH
    ? CHART_COLORS.restOfHouse
    : getColorForPath(path);
}

export const loadTile: TilePlugin = {
  kind: "tile",
  type: "load",
  isAvailable: ({ latest }) =>
    calculateAllLoads(enrichLatest(latest)).length > 0,
  Render: LoadTile,
};
