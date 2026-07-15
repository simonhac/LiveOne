"use client";

import { Sun } from "lucide-react";
import Tile from "@/components/Tile";
import type { LatestPointValues } from "@/lib/types/api";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  formatPowerValue,
  formatPowerSmallUnit,
  getPointValue,
  getMeasurementTime,
} from "./shared";

/** Solar can be a single total, local+remote children, or one lone child — resolve the shown value. */
function solarValueFrom(latest: LatestPointValues): {
  solarValue: number | null;
  solarLocal: number | null;
  solarRemote: number | null;
  showBreakdown: boolean;
} {
  const solarTotal = getPointValue(latest, "source.solar/power");
  const solarLocal = getPointValue(latest, "source.solar.local/power");
  const solarRemote = getPointValue(latest, "source.solar.remote/power");

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

  return { solarValue, solarLocal, solarRemote, showBreakdown };
}

function SolarTile({ latest, staleThresholdSeconds }: TileRenderProps) {
  const { solarValue, solarLocal, solarRemote, showBreakdown } =
    solarValueFrom(latest);
  return (
    <Tile
      title="Solar"
      value={formatPowerValue(solarValue ?? 0)}
      unit="kW"
      icon={<Sun className="w-6 h-6" />}
      iconColor="text-yellow-400"
      bgColor="bg-yellow-900/20"
      borderColor="border-yellow-700"
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, "source.solar/power") ||
        getMeasurementTime(latest, "source.solar.local/power") ||
        getMeasurementTime(latest, "source.solar.remote/power") ||
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
  );
}

export const solarTile: TilePlugin = {
  view: "solar",
  isAvailable: ({ latest }) => solarValueFrom(latest).solarValue !== null,
  Render: SolarTile,
};
