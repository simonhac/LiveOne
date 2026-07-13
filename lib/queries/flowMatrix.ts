import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { DAILY_STALE, SETTLED_STALE } from "./freshness";
import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";

export interface FlowMatrixQueryParams {
  systemId: SystemIdLike;
  /** Local YYYY-MM-DD bounds (inclusive of completed days). */
  startYMD: string;
  endYMD: string;
  timezoneOffsetMin?: number;
  /**
   * `legacy` (default) → `flow_1d` energy only (today's Sankey). `modern` → the superset
   * `flow_attr_1d`, which also carries the metric legs (emissions/renewable/cost/estimated) per day for
   * the provenance summary. The param is part of the query key so the two shapes never collide in cache.
   */
  source?: "legacy" | "modern";
  enabled?: boolean;
}

/**
 * Long-range (30D) Sankey from `/api/energy-flow-matrix` — RAW per-day matrices the client reduces (sum
 * for the window, pick one day for the hover). A window of fully-past days is immutable; a window that
 * includes today still accrues, so poll it slowly. `source=modern` additionally returns the metric legs.
 */
export function flowMatrixQuery(p: FlowMatrixQueryParams) {
  const offsetMin = p.timezoneOffsetMin ?? 600;
  const source = p.source ?? "legacy";
  const todayLocalYMD = new Date(Date.now() + offsetMin * 60_000)
    .toISOString()
    .slice(0, 10);
  const includesToday = p.endYMD >= todayLocalYMD;

  return queryOptions<DailyFlowMatrices>({
    queryKey: queryKeys.flowMatrix(p.systemId, p.startYMD, p.endYMD, source),
    queryFn: () =>
      fetchJson<DailyFlowMatrices>(
        `/api/energy-flow-matrix?systemId=${p.systemId}&start=${p.startYMD}&end=${p.endYMD}&source=${source}`,
      ),
    staleTime: includesToday ? DAILY_STALE : SETTLED_STALE,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: p.enabled ?? true,
  });
}
