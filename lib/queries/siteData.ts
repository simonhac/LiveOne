import { queryOptions } from "@tanstack/react-query";
import {
  fetchAndProcessSiteData,
  type ProcessedSiteData,
} from "@/lib/site-data-processor";
import { queryKeys, rangeKeyFor, type SystemIdLike } from "./keys";
import {
  boundaryRefetchInterval,
  CHART_STALE,
  DAILY_STALE,
  SETTLED_STALE,
} from "./freshness";

type Period = "1D" | "7D" | "30D";

const PERIOD_INTERVAL_MIN: Record<Period, number> = {
  "1D": 5,
  "7D": 30,
  "30D": 24 * 60,
};

export interface SiteDataQueryParams {
  systemId: SystemIdLike;
  period: Period;
  /** Explicit window (ISO) → settled/historical; absent → live trailing window. */
  start?: string;
  end?: string;
  timezoneOffsetMin?: number;
  paused?: boolean;
  enabled?: boolean;
}

/**
 * Mondo/composite "site" data: fetch + process + window in the queryFn (via the existing
 * `fetchAndProcessSiteData`). Doing the windowing at fetch time — not in `select` — keeps the
 * result referentially stable between renders; it slides forward only on each boundary refetch.
 */
export function siteDataQuery(p: SiteDataQueryParams) {
  const isLive = !(p.start && p.end);
  const rangeKey = isLive ? "live" : rangeKeyFor(p.start, p.end);

  let staleTime: number;
  let refetchInterval: number | false | (() => number);
  if (!isLive) {
    staleTime = SETTLED_STALE;
    refetchInterval = false;
  } else if (p.period === "30D") {
    staleTime = DAILY_STALE;
    refetchInterval = false;
  } else {
    staleTime = CHART_STALE;
    refetchInterval = boundaryRefetchInterval(
      PERIOD_INTERVAL_MIN[p.period],
      p.timezoneOffsetMin,
    );
  }

  return queryOptions<ProcessedSiteData>({
    queryKey: queryKeys.siteData(p.systemId, p.period, rangeKey),
    queryFn: () =>
      fetchAndProcessSiteData(String(p.systemId), p.period, p.start, p.end),
    staleTime,
    // Keep the previous day's chart on screen while a newly-navigated (uncached) window
    // loads — prevents the blank → axis-jump-to-now → spinner thrash. Only when just the
    // time window changed (same system + period); never flash another system/period's data.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey;
      return k && k[1] === String(p.systemId) && k[2] === p.period
        ? prev
        : undefined;
    },
    refetchInterval: p.paused ? false : refetchInterval,
    refetchOnWindowFocus: false,
    enabled: p.enabled ?? true,
  });
}
