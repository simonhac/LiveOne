"use client";

import { Battery } from "lucide-react";
import Tile from "@/components/Tile";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  formatPowerValue,
  formatPowerSmallUnit,
  getFlowChevron,
  getPointValue,
  getMeasurementTime,
} from "./shared";

/**
 * Battery SoC tile. Chrome is the battery's IDENTITY colour (green, matching `CHART_COLORS.battery`)
 * whenever there is flow — it used to flip green/orange on the charge (−) / discharge (+) sign, which
 * made green mean "charging" here and "exporting" on the Grid tile. Direction now rides entirely on
 * the chevron and the Charging/Discharging label. Below the 100 W dead band — the same threshold
 * `getFlowChevron` and the label already use — the tile goes grey, which reads as *no flow* rather
 * than as a direction. See lib/role-chrome.ts.
 */
function BatteryTile({ latest, staleThresholdSeconds }: TileRenderProps) {
  const batterySoc = getPointValue(latest, "bidi.battery/soc");
  const batteryPower = getPointValue(latest, "bidi.battery/power") || 0;
  const chrome =
    Math.abs(batteryPower) >= 100 ? ROLE_CHROME.battery : IDLE_CHROME;

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
            chrome.icon,
          )}
          <Battery className="w-6 h-6" />
        </span>
      }
      iconColor={chrome.icon}
      bgColor={chrome.tint}
      borderColor={chrome.border}
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
  kind: "tile",
  type: "battery",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "bidi.battery/soc") !== null,
  Render: BatteryTile,
};
