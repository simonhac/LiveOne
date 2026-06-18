import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";

/**
 * A composition dashboard summary as serialized by `GET /api/dashboards` (server `DashboardSummary`,
 * but `updatedAt` arrives as an ISO string over the wire).
 */
export interface DashboardSummaryDTO {
  id: number;
  displayName: string | null;
  alias: string | null;
  cardCount: number;
  updatedAt: string;
  /** "owner" = the signed-in user owns it; "shared" = reachable via a grant (read-only). */
  access: "owner" | "shared";
}

export interface MyDashboardsResponse {
  dashboards: DashboardSummaryDTO[];
}

/** Query key for the signed-in user's composition dashboards (invalidate after create/rename/delete). */
export const MY_DASHBOARDS_KEY = ["dashboards", "mine"] as const;

/**
 * The signed-in user's composition dashboards (`GET /api/dashboards`) — powers the header dashboard
 * switcher. User config that the user mutates from the same surface, so cache briefly and invalidate
 * explicitly after create/rename/delete; also refetch on focus to catch edits from another tab.
 * Disabled in the read-only shared view (`?access=`), which has no real auth.
 */
export function myDashboardsQuery(enabled = true) {
  return queryOptions({
    queryKey: MY_DASHBOARDS_KEY,
    queryFn: () => fetchJson<MyDashboardsResponse>("/api/dashboards"),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
