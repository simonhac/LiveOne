"use client";

import { Battery } from "lucide-react";
import TileSurface, { TileHeader } from "@/components/ui/tile-surface";
import { useStaleness } from "@/components/ui/tile-stale";
import ProgressRing from "@/components/ui/progress-ring";
import DirectionChip, {
  FLOW_DOUBLE_W,
  flowDirection,
} from "@/components/ui/direction-chip";
import TrendRow from "@/components/ui/trend-row";
import Value from "@/components/ui/value";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import { TILE_RING, TILE_RING_VALUE, TILE_STALE } from "@/lib/tile-style";
import type { TilePlugin, TileRenderProps } from "./types";
import { formatPowerValue, getPointValue, getMeasurementTime } from "./shared";

/** Below this state of charge the ring leaves its identity colour and warns. */
const LOW_SOC = 20;
const LOW_RGB = "rgb(239, 68, 68)"; // red-500
/** The ring's gradient runs green-400 → green-300: one hue, lit toward its tip. */
const BATTERY_LIGHT_RGB = "rgb(134, 239, 172)";

/**
 * Battery — a fat ring holding the state of charge (it pairs with the EV tile's ring), and under it
 * one Trends row: the direction chip, what the battery is doing, and at what power.
 *
 * The ring is the battery's IDENTITY colour, green, whatever the battery is doing — direction rides
 * on the chip (up = discharge, down = charge; see `DirectionChip`), never on the colour, which used
 * to make green mean "charging" here and "exporting" on the Grid tile. The one exception is a low
 * charge: under 20% the ring goes red, because that is the fact the reader most needs from it.
 */
function BatteryTile({ latest, staleThresholdSeconds }: TileRenderProps) {
  const batterySoc = getPointValue(latest, "bidi.battery/soc") ?? 0;
  const batteryPower = getPointValue(latest, "bidi.battery/power") || 0;
  // Positive battery power is DISCHARGE: energy leaving the battery, so "up".
  const direction = flowDirection(batteryPower, true);
  const measurementTime =
    getMeasurementTime(latest, "bidi.battery/soc") ?? undefined;
  const staleness = useStaleness(measurementTime, staleThresholdSeconds);

  const low = batterySoc < LOW_SOC;
  const ringColor = low ? LOW_RGB : ROLE_CHROME.battery.rgb;
  // Stale dims the live readings and keeps their colour — see `TILE_STALE`.
  const staleClass = staleness.isStale ? TILE_STALE : "";

  return (
    <TileSurface surfaceClassName="flex flex-col">
      <TileHeader
        title="Battery"
        icon={<Battery />}
        tone={ROLE_CHROME.battery.value}
        staleness={staleness}
        measurementTime={measurementTime}
      />
      <div className="flex flex-1 items-center justify-center py-2">
        <ProgressRing
          fraction={batterySoc / 100}
          color={ringColor}
          gradientTo={low ? undefined : BATTERY_LIGHT_RGB}
          className={`${TILE_RING} ${staleClass}`}
        >
          <span className={`${TILE_RING_VALUE} text-white`}>
            <Value value={String(Math.round(batterySoc))} unit="%" />
          </span>
        </ProgressRing>
      </div>
      <div className={staleClass}>
        <TrendRow
          chip={
            <DirectionChip
              direction={direction}
              color={ROLE_CHROME.battery.rgb}
              double={Math.abs(batteryPower) > FLOW_DOUBLE_W}
            />
          }
          label={
            direction === "idle"
              ? "Idle"
              : direction === "up"
                ? "Discharging"
                : "Charging"
          }
          value={
            direction === "idle" ? (
              "—"
            ) : (
              <Value
                value={formatPowerValue(Math.abs(batteryPower))}
                unit="kW"
              />
            )
          }
          valueColor={
            direction === "idle" ? IDLE_CHROME.value : ROLE_CHROME.battery.value
          }
        />
      </div>
    </TileSurface>
  );
}

export const batteryTile: TilePlugin = {
  kind: "tile",
  type: "battery",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "bidi.battery/soc") !== null,
  Render: BatteryTile,
};
