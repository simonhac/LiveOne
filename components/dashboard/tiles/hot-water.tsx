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
 * state) is D, that's exactly the window the site chart's own history fetch already requests — so
 * this reads `siteDataQuery`'s cache (same queryKey ⇒ React Query dedupes the two, no second
 * request) instead of firing its own. For W/M/Y the main fetch's window/resolution don't match, so
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
  const wantShared = period === "D";

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
  // POSITIONAL: one slot per 5-minute interval of the window, null where there is no reading. The
  // series is a dense grid (lib/history/readings-pg.ts densifies it), and its newest intervals are
  // routinely null while the producer catches up — compacting those away would let the sparkline
  // stretch the remaining points across the full width and claim to be current. See
  // lib/charts/sparkline.ts.
  const hwsSparkValues = useMemo<(number | null)[]>(() => {
    const toSlot = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    if (wantShared) {
      const values = sharedSite.data?.hwsTemperature?.values;
      return Array.isArray(values) ? values.map(toSlot) : [];
    }
    const series = (
      hwsHistory.data as { data?: Array<{ history?: { data?: unknown[] } }> }
    )?.data?.[0]?.history?.data;
    if (!Array.isArray(series)) return [];
    return series.map(toSlot);
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
  kind: "tile",
  type: "hotWater",
  isAvailable: ({ latest }) =>
    getPointValue(latest, "load.hws/temperature") !== null,
  Render: HotWaterTile,
};
