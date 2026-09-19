"use client";

import { Sun } from "lucide-react";
import Tile from "@/components/Tile";
import MiniBars, { MiniBarsSkeleton } from "@/components/ui/mini-bars";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import type { LatestPointValues } from "@/lib/types/api";
import type { TilePlugin, TileRenderProps } from "./types";
import {
  formatPowerValue,
  formatPowerSmallUnit,
  getPointValue,
  getMeasurementTime,
} from "./shared";
import { pickSolar, useSiteBars } from "./use-site-bars";
import { SOLAR_TOTAL_PATH } from "@/lib/areas/derived-display-paths";

/** Below this the array is asleep, and the hero greys rather than claiming a yellow 0.0. */
const GENERATING_W = 50;

/** Solar can be a single total, local+remote children, or one lone child — resolve the shown value. */
function solarValueFrom(latest: LatestPointValues): {
  solarValue: number | null;
  solarLocal: number | null;
  solarRemote: number | null;
  showBreakdown: boolean;
} {
  const solarTotal = getPointValue(latest, SOLAR_TOTAL_PATH);
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

/**
 * Solar — the Activity app's Step Count card: "Now" over the live generation in solar yellow, then
 * the period's generation as bars (the same series the stacked chart draws, read from its cache).
 * At night the hero greys and the bars still show the day that was.
 */
function SolarTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const { solarValue, solarLocal, solarRemote, showBreakdown } =
    solarValueFrom(latest);
  const { bars, pending: barsPending } = useSiteBars(systemId, pickSolar);
  const generating = (solarValue ?? 0) >= GENERATING_W;
  return (
    <Tile
      title="Solar"
      icon={<Sun />}
      tone={ROLE_CHROME.solar.value}
      label="Now"
      value={formatPowerValue(solarValue ?? 0)}
      unit="kW"
      valueColor={generating ? ROLE_CHROME.solar.value : IDLE_CHROME.value}
      staleThresholdSeconds={staleThresholdSeconds}
      measurementTime={
        getMeasurementTime(latest, "source.solar/power") ||
        getMeasurementTime(latest, "source.solar.local/power") ||
        getMeasurementTime(latest, "source.solar.remote/power") ||
        undefined
      }
      extraInfo={
        showBreakdown ? (
          <>
            {solarLocal !== null && (
              <>Local {formatPowerSmallUnit(solarLocal)}</>
            )}
            {solarLocal !== null && solarRemote !== null && " · "}
            {solarRemote !== null && (
              <>Remote {formatPowerSmallUnit(solarRemote)}</>
            )}
          </>
        ) : undefined
      }
      extra={
        bars.length > 0 ? (
          <MiniBars
            bars={bars}
            color={ROLE_CHROME.solar.rgb}
            className="h-10"
            ariaLabel="Solar generation over the period"
          />
        ) : barsPending ? (
          <MiniBarsSkeleton className="h-10" />
        ) : undefined
      }
    />
  );
}

export const solarTile: TilePlugin = {
  kind: "tile",
  type: "solar",
  isAvailable: ({ latest }) => solarValueFrom(latest).solarValue !== null,
  Render: SolarTile,
};
