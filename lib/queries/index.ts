import type { QueryClient } from "@tanstack/react-query";
import { isDeviceQuery, type SystemIdLike } from "./keys";

export * from "./keys";
export * from "./fetcher";
export * from "./freshness";
export { dashboardDataQuery } from "./data";
export { latestReadingsQuery } from "./latest";
export { historyQuery } from "./history";
export { siteDataQuery } from "./siteData";
export { amberQuery } from "./amber";
export { runPeriodsQuery } from "./runPeriods";
export { readableAreasQuery } from "./areas";
export { provenanceDailyQuery } from "./provenanceDaily";
export {
  myDashboardsQuery,
  MY_DASHBOARDS_KEY,
  type MyDashboardsResponse,
} from "./dashboards";
export { userPreferencesQuery, USER_PREFERENCES_KEY } from "./preferences";

/**
 * Invalidate every live/historical query for a device — the React Query replacement for
 * the old `triggerDashboardRefresh()` event bus. Call after a manual Poll-Now or Amber-Sync.
 * Works across routes because the QueryClient is a global singleton.
 */
export function invalidateDevice(
  queryClient: QueryClient,
  systemId: SystemIdLike,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => isDeviceQuery(systemId, query.queryKey),
  });
}
