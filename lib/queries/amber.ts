import { queryOptions } from "@tanstack/react-query";
import { fromDate } from "@internationalized/date";
import { encodeI18nToUrlSafeString } from "@/lib/url-date";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { AMBER_STALE, boundaryRefetchInterval } from "./freshness";

const AMBER_SERIES = [
  "bidi.grid.import/rate.avg",
  "bidi.grid.import/rate.quality",
  "bidi.grid.renewables/proportion.avg",
  "bidi.grid.import/value.avg",
  "bidi.grid.export/value.avg",
].join(",");

export interface AmberQueryParams {
  systemId: SystemIdLike;
  displayTimezone?: string | null;
  paused?: boolean;
}

/**
 * Amber 30-minute price/usage timeline (`/api/history`, 30m). The trailing window
 * (past-12h … future-24h, rounded to 30m) is computed INSIDE the queryFn so each
 * boundary refetch slides it forward — the key stays "live" so it doesn't churn.
 *
 * Amber is "settled but mutable": its past intervals get upgraded forecast→actual→billable,
 * so staleTime is 0 (a refetch is always allowed) and it polls on the 30m boundary. After a
 * manual Amber-Sync the caller should additionally `invalidateQueries({ queryKey: amber(id) })`.
 */
export function amberQuery(p: AmberQueryParams) {
  const tz = p.displayTimezone || "Australia/Sydney";
  return queryOptions({
    queryKey: queryKeys.amber(p.systemId, "live"),
    queryFn: () => {
      const now = new Date();
      const roundedNow = new Date(now);
      roundedNow.setMinutes(Math.floor(now.getMinutes() / 30) * 30, 0, 0);
      const past12h = new Date(roundedNow.getTime() - 12 * 60 * 60 * 1000);
      const future24h = new Date(roundedNow.getTime() + 24 * 60 * 60 * 1000);
      const startEnc = encodeI18nToUrlSafeString(
        fromDate(past12h, tz),
        true,
      ) as string;
      const endEnc = encodeI18nToUrlSafeString(
        fromDate(future24h, tz),
        true,
      ) as string;
      return fetchJson(
        `/api/history?systemId=${p.systemId}&startTime=${startEnc}&endTime=${endEnc}&interval=30m&series=${AMBER_SERIES}`,
      );
    },
    staleTime: AMBER_STALE,
    refetchInterval: p.paused ? false : boundaryRefetchInterval(30),
    refetchOnWindowFocus: !p.paused,
  });
}
