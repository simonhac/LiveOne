import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys } from "./keys";
import { LIVE_STALE } from "./freshness";
import type { ChargeLimitJson } from "@/lib/automations/progress";

export interface ChargeAutomationsResponse {
  automations: ChargeLimitJson[];
}

/**
 * An area's charge-limit automations — `GET /api/v4/automations?area=ar_…`.
 *
 * LIVE cadence, not config cadence: `armedAt` and `armedContext` are rewritten by the minutely
 * cron evaluator, so the "12.4 so far" figure and the armed/waiting state both go stale in
 * seconds. Same 25 s / 30 s pairing as `dashboardDataQuery`, so the tile's counter and the
 * baseline it is measured against refresh together.
 *
 * The response type is `ChargeLimitJson` (ISO-string timestamps), NOT the server's
 * `AutomationWire` — see that type's note. `fetchJson` revives nothing.
 *
 * ⚠️ The route is area-OWNER gated, so callers must AND-in their own control gate:
 * `useQuery({ ...chargeAutomationsQuery(areaId), enabled: !!areaId && showControls })`. Firing it
 * for a viewer earns a guaranteed 403 that React Query would then retry.
 */
export function chargeAutomationsQuery(areaId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.automations(areaId ?? ""),
    queryFn: () =>
      fetchJson<ChargeAutomationsResponse>(
        `/api/v4/automations?area=${encodeURIComponent(areaId ?? "")}`,
      ),
    staleTime: LIVE_STALE,
    refetchInterval: 30_000,
    enabled: !!areaId,
  });
}
