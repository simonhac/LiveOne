import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { DAILY_STALE, SETTLED_STALE } from "./freshness";
import { encodeHistoryWindow } from "@/lib/charts/history-window";
import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";

export interface AttributedFlowDailyQueryParams {
  systemId: SystemIdLike;
  /** Local YYYY-MM-DD bounds (inclusive of completed days). */
  startYMD: string;
  endYMD: string;
  timezoneOffsetMin?: number;
  enabled?: boolean;
}

const EMPTY_DAILY_FLOW: DailyFlowMatrices = {
  sources: [],
  loads: [],
  days: [],
};

/**
 * The 1d ATTRIBUTED Sankey payload (energy + emissions/renewable/cost/estimated legs) for a range of
 * completed local days, via `/api/history?interval=1d&include=sankey`. Replaces the retired
 * `/api/energy-flow-matrix?source=modern` (`flowMatrixQuery`) — same `DailyFlowMatrices` shape out, so
 * `reduceLoadProvenance`/`reduceSourceProvenance` callers (e.g. the ev-provenance card) are unaffected.
 */
export function attributedFlowDailyQuery(p: AttributedFlowDailyQueryParams) {
  const offsetMin = p.timezoneOffsetMin ?? 600;
  const todayLocalYMD = new Date(Date.now() + offsetMin * 60_000)
    .toISOString()
    .slice(0, 10);
  const includesToday = p.endYMD >= todayLocalYMD;
  const { startTime, endTime } = encodeHistoryWindow(
    p.startYMD,
    p.endYMD,
    "1d",
  );

  return queryOptions<DailyFlowMatrices>({
    queryKey: queryKeys.attributedFlowDaily(p.systemId, p.startYMD, p.endYMD),
    queryFn: async () => {
      const data = await fetchJson<{ attributedFlow?: DailyFlowMatrices }>(
        `/api/history?interval=1d&startTime=${startTime}&endTime=${endTime}&systemId=${p.systemId}&include=sankey`,
      );
      return data.attributedFlow ?? EMPTY_DAILY_FLOW;
    },
    staleTime: includesToday ? DAILY_STALE : SETTLED_STALE,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: p.enabled ?? true,
  });
}
