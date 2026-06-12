import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, rangeKeyFor, type SystemIdLike } from "./keys";
import {
  type Interval,
  intervalMinutes,
  boundaryRefetchInterval,
  CHART_STALE,
  DAILY_STALE,
  SETTLED_STALE,
} from "./freshness";

export interface HistoryQueryParams {
  systemId: SystemIdLike;
  interval: Interval;
  /** Relative window, e.g. "24h" — a LIVE trailing window (server computes it from now). */
  last?: string;
  /** Explicit URL-safe-encoded window — a SETTLED past window. */
  startTime?: string;
  endTime?: string;
  /** Comma-joined series patterns in API format (NOT URL-encoded — `/` and `,` are literal). */
  series?: string;
  /** Extra comma-joined includes, e.g. "sankey". */
  include?: string;
  /** Drives boundary-aligned refetch in the system's local time. */
  timezoneOffsetMin?: number;
  /** When true (modal open) suspend background polling. */
  paused?: boolean;
  /** Disable the query entirely. */
  enabled?: boolean;
}

/** Build the `/api/history` URL without encoding `/`,`,` in series/include (the API expects them literal). */
function buildHistoryUrl(p: HistoryQueryParams): string {
  let url = `/api/history?interval=${p.interval}&systemId=${p.systemId}`;
  if (p.startTime && p.endTime) {
    url += `&startTime=${p.startTime}&endTime=${p.endTime}`;
  } else if (p.last) {
    url += `&last=${p.last}`;
  }
  if (p.series) url += `&series=${p.series}`;
  if (p.include) url += `&include=${p.include}`;
  return url;
}

/**
 * Generic `/api/history` query. Returns the raw OpenNEM payload — components window/transform
 * it in a `useMemo` over the cached data (not in `select`) so chart arrays stay referentially
 * stable while still updating on each refetch.
 *
 * Freshness: a LIVE window (`last`) refetches on the interval boundary (1d is slow); an explicit
 * SETTLED window is treated as immutable (`staleTime: Infinity`, no polling).
 */
export function historyQuery(p: HistoryQueryParams) {
  const isLive = !(p.startTime && p.endTime);
  const rangeKey = isLive ? "live" : rangeKeyFor(p.startTime, p.endTime);
  const seriesKey = `${p.series ?? "all"}|${p.include ?? ""}`;

  let staleTime: number;
  let refetchInterval: number | false | (() => number);
  if (!isLive) {
    staleTime = SETTLED_STALE;
    refetchInterval = false;
  } else if (p.interval === "1d") {
    staleTime = DAILY_STALE;
    refetchInterval = false;
  } else {
    staleTime = CHART_STALE;
    refetchInterval = boundaryRefetchInterval(
      intervalMinutes(p.interval),
      p.timezoneOffsetMin,
    );
  }

  return queryOptions({
    queryKey: queryKeys.history(p.systemId, p.interval, rangeKey, seriesKey),
    queryFn: () => fetchJson(buildHistoryUrl(p)),
    staleTime,
    refetchInterval: p.paused ? false : refetchInterval,
    refetchOnWindowFocus: false,
    enabled: p.enabled ?? true,
  });
}
