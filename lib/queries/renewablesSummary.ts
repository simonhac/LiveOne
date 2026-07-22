import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, rangeKeyFor } from "./keys";
import { DAILY_STALE, SETTLED_STALE } from "./freshness";
import type { RenewablesSummaryResponse } from "@/lib/renewables/summary";

/** handle → { areaId } resolution via `/api/areas/by-handle/[handle]`. The renewables tile only
 *  receives the numeric handle but the summary route is keyed by the area UUID. Cached indefinitely
 *  (a handle's area never changes) and shared across tiles for the same handle. */
export function areaByHandleQuery(systemId: number, enabled = true) {
  return queryOptions<{ areaId: string; systemId: number }>({
    queryKey: queryKeys.areaByHandle(systemId),
    queryFn: () =>
      fetchJson<{ areaId: string; systemId: number }>(
        `/api/areas/by-handle/${systemId}`,
      ),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export interface RenewablesSummaryQueryParams {
  areaId: string;
  /** Area-local YYYY-MM-DD inclusive. Omit both for the server default (today so far). */
  startDay?: string;
  endDay?: string;
  enabled?: boolean;
}

/**
 * The renewables tile's three-metric summary from `/api/areas/[areaId]/renewables-summary`. An
 * explicit start+end window is settled history; a live/default window only goes stale on the daily
 * tier (the underlying flow_attr rollup changes at most once a day, at the nightly heal).
 */
export function renewablesSummaryQuery(p: RenewablesSummaryQueryParams) {
  const isSettled = !!(p.startDay && p.endDay);
  const rangeKey = rangeKeyFor(p.startDay, p.endDay);

  const search = new URLSearchParams();
  if (p.startDay) search.set("start", p.startDay);
  if (p.endDay) search.set("end", p.endDay);
  const qs = search.toString();
  const url = `/api/areas/${p.areaId}/renewables-summary${qs ? `?${qs}` : ""}`;

  return queryOptions<RenewablesSummaryResponse>({
    queryKey: queryKeys.renewablesSummary(p.areaId, rangeKey),
    queryFn: () => fetchJson<RenewablesSummaryResponse>(url),
    staleTime: isSettled ? SETTLED_STALE : DAILY_STALE,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: p.enabled ?? true,
  });
}
