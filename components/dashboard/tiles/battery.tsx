"use client";

import { Battery } from "lucide-react";
import Tile from "@/components/Tile";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  formatPowerValue,
  formatPowerSmallUnit,
  getFlowChevron,
  getPointValue,
  getMeasurementTime,
} from "./shared";

/** Battery SoC tile — color/background/chevron keyed on the charge (−) / discharge (+) sign. */
function BatteryTile({ latest, staleThresholdSeconds }: TileRenderProps) {
  const batterySoc = getPointValue(latest, "bidi.battery/soc");
  const batteryPower = getPointValue(latest, "bidi.battery/power") || 0;

  return (
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
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, "bidi.battery/soc") || undefined
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
  );
}

export const batteryTile: TilePlugin = {
  view: "battery",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "bidi.battery/soc") !== null,
  Render: BatteryTile,
};
