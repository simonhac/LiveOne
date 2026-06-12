import { queryOptions } from "@tanstack/react-query";
import { fetchJsonWithDates } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { LIVE_STALE } from "./freshness";

/**
 * Main dashboard payload: `/api/data?systemId=` → `{ system, latest, availableSystems }`.
 * Latest values are the low-latency path, so refetch every 30s and on window focus.
 * Uses the Date-reviving parse to match the legacy consumption (`measurementTime: Date`).
 *
 * @param paused when true (a modal is open) background polling is suspended without
 *   unmounting the query (so reopening doesn't trigger a refetch storm).
 */
export function dashboardDataQuery(
  systemId: SystemIdLike,
  { paused = false }: { paused?: boolean } = {},
) {
  return queryOptions({
    queryKey: queryKeys.data(systemId),
    queryFn: () => fetchJsonWithDates(`/api/data?systemId=${systemId}`),
    staleTime: LIVE_STALE,
    refetchInterval: paused ? false : 30_000,
    refetchOnWindowFocus: !paused,
    enabled: systemId != null && systemId !== "",
  });
}
