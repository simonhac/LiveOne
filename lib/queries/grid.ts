import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { LIVE_STALE, boundaryRefetchInterval } from "./freshness";

/**
 * Live "now" grid signals for an OpenElectricity NEM-region system, served by
 * `GET /api/grid/{systemId}`. Each metric is the latest cached value (or null when
 * absent). Stored units are the OE serving units — convert for display at the consumer:
 *   price ¢/kWh        = price.value / 10        (stored $/MWh)
 *   emissions gCO₂/kWh = emissionsIntensity.value * 1000 (stored tCO2e/MWh)
 *   renewables %       = renewables.value (round) (stored %)
 */
export interface GridLiveValues {
  systemId: number;
  region: string;
  price: { value: number; measurementTime: string } | null;
  emissionsIntensity: { value: number; measurementTime: string } | null;
  renewables: { value: number; measurementTime: string } | null;
}

/**
 * Live grid signals for a region system. Polls on the 5-minute boundary (OE is 5m-native)
 * and is short-stale like other latest values. The region system is read cross-system, so
 * the caller passes the OE region's systemId, not the dashboard's own.
 */
export function gridLiveQuery(
  regionSystemId: number | string,
  opts?: { paused?: boolean },
) {
  const paused = opts?.paused ?? false;
  return queryOptions({
    queryKey: queryKeys.grid(regionSystemId as SystemIdLike, "live"),
    queryFn: () => fetchJson<GridLiveValues>(`/api/grid/${regionSystemId}`),
    staleTime: LIVE_STALE,
    refetchInterval: paused ? false : boundaryRefetchInterval(5),
    refetchOnWindowFocus: !paused,
    enabled: regionSystemId != null && regionSystemId !== "",
  });
}
