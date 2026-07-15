import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, rangeKeyFor } from "./keys";
import { DAILY_STALE, SETTLED_STALE } from "./freshness";
import type { ProvenanceDailyResponse } from "@/lib/battery-provenance/field-registry";

export interface ProvenanceDailyQueryParams {
  areaId: string;
  /** Area-local YYYY-MM-DD inclusive. Omit both for the server default (trailing year → yesterday). */
  startDay?: string;
  endDay?: string;
  enabled?: boolean;
}

/**
 * Battery-provenance daily history from `/api/areas/[areaId]/provenance-daily` — the dense columnar
 * {@link ProvenanceDailyResponse} the history panel charts/tables. An explicit start+end window is
 * settled history (immutable, no polling); a LIVE trailing window (either bound omitted) only goes
 * stale on the daily tier — the underlying rows change at most once a day (nightly learn).
 */
export function provenanceDailyQuery(p: ProvenanceDailyQueryParams) {
  const isSettled = !!(p.startDay && p.endDay);
  const rangeKey = rangeKeyFor(p.startDay, p.endDay);

  const search = new URLSearchParams();
  if (p.startDay) search.set("start", p.startDay);
  if (p.endDay) search.set("end", p.endDay);
  const qs = search.toString();
  const url = `/api/areas/${p.areaId}/provenance-daily${qs ? `?${qs}` : ""}`;

  return queryOptions<ProvenanceDailyResponse>({
    queryKey: queryKeys.provenanceDaily(p.areaId, rangeKey),
    queryFn: () => fetchJson<ProvenanceDailyResponse>(url),
    staleTime: isSettled ? SETTLED_STALE : DAILY_STALE,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    // Keep the previous window on screen while a newly-navigated (uncached) window loads — but
    // only when just the window changed (same area); never flash another area's data.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey;
      return k && k[1] === p.areaId ? prev : undefined;
    },
    enabled: p.enabled ?? true,
  });
}
