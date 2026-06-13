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
export { gridLiveQuery, type GridLiveValues } from "./grid";
export {
  dashboardDescriptorQuery,
  type DashboardDescriptorResponse,
} from "./dashboard";

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
