"use client";

import { Zap } from "lucide-react";
import Tile from "@/components/Tile";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  formatPowerValue,
  getFlowChevron,
  getPointValue,
  getMeasurementTime,
} from "./shared";

/** Grid import/export tile — import (red) / export (green) / idle under 100 W. */
function HouseToGridTile({ latest, staleThresholdSeconds }: TileRenderProps) {
  const gridPower = getPointValue(latest, "bidi.grid/power") || 0;

  return (
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
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, "bidi.grid/power") || undefined
      }
      extraInfo={
        gridPower >= 100
          ? "Importing"
          : gridPower <= -100
            ? "Exporting"
            : undefined
      }
    />
  );
}

export const houseToGridTile: TilePlugin = {
  view: "house-to-grid",
  isAvailable: ({ latest, showGrid }) =>
    showGrid && getPointValue(latest, "bidi.grid/power") !== null,
  Render: HouseToGridTile,
};
