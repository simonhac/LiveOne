import type { QueryClient } from "@tanstack/react-query";
import { isSystemQuery, type SystemIdLike } from "./keys";

export * from "./keys";
export * from "./fetcher";
export * from "./freshness";
export { dashboardDataQuery } from "./data";
export { latestReadingsQuery, type LatestReadingValue } from "./latest";
export { historyQuery, type HistoryQueryParams } from "./history";
export { siteDataQuery, type SiteDataQueryParams } from "./siteData";
export { flowMatrixQuery, type FlowMatrixQueryParams } from "./flowMatrix";
export { amberQuery, type AmberQueryParams } from "./amber";
export {
  runPeriodsQuery,
  type RunPeriodsQueryParams,
  type RunPeriodsResponse,
  type RunPeriodEvent,
} from "./runPeriods";
export { readableAreasQuery, type ReadableAreasResponse } from "./areas";
export {
  provenanceDailyQuery,
  type ProvenanceDailyQueryParams,
} from "./provenanceDaily";
export {
  myDashboardsQuery,
  MY_DASHBOARDS_KEY,
  type MyDashboardsResponse,
  type DashboardSummaryDTO,
} from "./dashboards";
export {
  userPreferencesQuery,
  USER_PREFERENCES_KEY,
  type UserPreferencesResponse,
  type UserPreferencesDTO,
} from "./preferences";

/**
 * Invalidate every live/historical query for a system — the React Query replacement for
 * the old `triggerDashboardRefresh()` event bus. Call after a manual Poll-Now or Amber-Sync.
 * Works across routes because the QueryClient is a global singleton.
 */
export function invalidateSystem(
  queryClient: QueryClient,
  systemId: SystemIdLike,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => isSystemQuery(systemId, query.queryKey),
  });
}
