import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { LIVE_STALE } from "./freshness";

/**
 * Revive the `latest` map's `measurementTime` ISO strings into Date objects for the dashboard
 * cards (which do Date math on them). The CACHE keeps the raw JSON (ISO strings) so it
 * serializes cleanly — this matters for the future RSC prefetch/dehydration follow-up, where
 * Date instances can't cross the boundary. This `select` derives the Date view from that cache;
 * it's module-level (stable identity) so React Query memoizes the result.
 */
function reviveDashboardDates(result: unknown) {
  const r = result as { latest?: Record<string, unknown> } | null;
  const latest = r?.latest;
  if (!latest || typeof latest !== "object") return result;
  const revived: Record<string, unknown> = {};
  for (const [path, point] of Object.entries(latest)) {
    const mt = (point as { measurementTime?: unknown } | null)?.measurementTime;
    revived[path] =
      point && typeof mt === "string"
        ? { ...(point as object), measurementTime: new Date(mt) }
        : point;
  }
  return { ...(result as object), latest: revived };
}

/**
 * Main dashboard payload: `/api/data?systemId=` → `{ system, latest, availableSystems }`.
 * Latest values are the low-latency path, so refetch every 30s and on window focus.
 * The cache holds plain JSON (ISO strings); `select` revives `latest` timestamps to Dates.
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
    queryFn: () => fetchJson(`/api/data?systemId=${systemId}`),
    select: reviveDashboardDates,
    staleTime: LIVE_STALE,
    refetchInterval: paused ? false : 30_000,
    refetchOnWindowFocus: !paused,
    enabled: systemId != null && systemId !== "",
  });
}
