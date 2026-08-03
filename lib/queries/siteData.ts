import { queryOptions } from "@tanstack/react-query";
import {
  fetchAndProcessSiteData,
  type ProcessedSiteData,
} from "@/lib/site-data-processor";
import { queryKeys, rangeKeyFor, type SystemIdLike } from "./keys";
import type { ChartTimeRange } from "@/lib/charts/temporal";
import {
  boundaryRefetchInterval,
  CHART_STALE,
  DAILY_STALE,
  SETTLED_STALE,
} from "./freshness";

type Period = ChartTimeRange;

const PERIOD_INTERVAL_MIN: Record<Period, number> = {
  D: 5,
  W: 30,
  M: 24 * 60,
  Y: 24 * 60,
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
  } else if (p.period === "M" || p.period === "Y") {
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
    // time window changed (same device + period); never flash another device/period's data.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey;
      return k && k[1] === String(p.systemId) && k[2] === p.period
        ? prev
        : undefined;
    },
    refetchInterval: p.paused ? false : refetchInterval,
    // A LIVE window must catch up the moment you look at it. React Query suspends
    // `refetchInterval` while the document is hidden, so without this a backgrounded tab comes
    // back with the chart frozen at whatever it last fetched while the tiles — which DO refetch on
    // focus (lib/queries/data.ts) — jump to now. The two then disagree on screen, for up to a
    // whole boundary interval. A settled window keeps `staleTime: SETTLED_STALE`, so focus is a
    // no-op there either way; `isLive` just says so out loud.
    refetchOnWindowFocus: isLive,
    enabled: p.enabled ?? true,
  });
}
