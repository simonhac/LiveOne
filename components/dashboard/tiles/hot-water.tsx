"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import HwsSmallCard from "@/components/HwsSmallCard";
import { historyQuery, siteDataQuery } from "@/lib/queries";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { DEFAULT_HWS_MODEL_OPTIONS } from "@/lib/hws-model";
import type { TilePlugin, TileRenderProps } from "./types";
import { getPointValue, getMeasurementTime } from "./shared";

/**
 * The hot-water tile. Owns the 24h sparkline fetch (orchestrated here so HwsSmallCard stays
 * presentational like the other mini-cards) — the one tile with a data query. Only fires when a
 * host systemId is known (the prop-driven card gallery omits it) and there is HWS temperature data.
 *
 * The sparkline is always a 24h/5m window. When the section's shared temporal-navigator period (URL
 * state) is 1D, that's exactly the window the site chart's own history fetch already requests — so
 * this reads `siteDataQuery`'s cache (same queryKey ⇒ React Query dedupes the two, no second
 * request) instead of firing its own. For 7D/30D the main fetch's window/resolution don't match, so
 * this keeps its dedicated fetch.
 */
function HotWaterTile({
  latest,
  systemId,
  staleThresholdSeconds,
}: TileRenderProps) {
  const hwsTemp = getPointValue(latest, "load.hws/temperature");
  const wantData = systemId != null && hwsTemp != null;

  const { period, start, end } = useTemporalRange({ timezoneOffsetMin: 0 });
  const wantShared = period === "1D";

  const sharedSite = useQuery(
    siteDataQuery({
      systemId: systemId ?? "",
      period,
      start,
      end,
      enabled: wantShared && wantData,
    }),
  );
  const hwsHistory = useQuery(
    historyQuery({
      systemId: systemId ?? "",
      interval: "5m",
      last: "24h",
      series: "load.hws/temperature.avg",
      enabled: !wantShared && wantData,
    }),
  );
  const hwsSparkValues = useMemo<number[]>(() => {
    if (wantShared) {
      const values = sharedSite.data?.hwsTemperature?.values;
      return Array.isArray(values)
        ? values.filter((v): v is number => typeof v === "number")
        : [];
    }
    const series = (
      hwsHistory.data as { data?: Array<{ history?: { data?: unknown[] } }> }
    )?.data?.[0]?.history?.data;
    if (!Array.isArray(series)) return [];
    return series.filter((v: unknown): v is number => typeof v === "number");
  }, [wantShared, sharedSite.data, hwsHistory.data]);

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
