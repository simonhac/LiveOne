"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import HwsSmallCard from "@/components/HwsSmallCard";
import { historyQuery } from "@/lib/queries";
import { DEFAULT_HWS_MODEL_OPTIONS } from "@/lib/hws-model";
import type { TilePlugin, TileRenderProps } from "./types";
import { getPointValue, getMeasurementTime } from "./shared";

/**
 * The hot-water tile. Owns the 24h sparkline fetch (orchestrated here so HwsSmallCard stays
 * presentational like the other mini-cards) — the one tile with a data query. Only fires when a
 * host systemId is known (the prop-driven card gallery omits it) and there is HWS temperature data.
 */
function HotWaterTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const hwsTemp = getPointValue(latest, "load.hws/temperature");

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

  return (
    <HwsSmallCard
      faucetC={hwsTemp}
      sparkValues={hwsSparkValues}
      measurementTime={
        getMeasurementTime(latest, "load.hws/temperature") ?? undefined
      }
      heating={
        (getPointValue(latest, "load.hws/power") ?? 0) >
        DEFAULT_HWS_MODEL_OPTIONS.onThresholdW
      }
      staleThresholdSeconds={staleThresholdSeconds}
    />
  );
}

export const hotWaterTile: TilePlugin = {
  view: "hotWater",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "load.hws/temperature") !== null,
  Render: HotWaterTile,
};
