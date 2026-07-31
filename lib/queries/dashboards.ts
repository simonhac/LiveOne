import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";

/**
 * A composition dashboard summary as serialized by `GET /api/v4/dashboards` (server
 * `DashboardSummary`, but `updatedAt` arrives as an ISO string over the wire).
 *
 * ⚠️ `name`/`slug`, NOT the DAO's `displayName`/`alias`: the v4 route speaks the same vocabulary as
 * `GET`/`PATCH /api/v4/dashboards/{id}`, so a list entry is directly patchable. The SSR seed in
 * `app/dashboard/[...slug]/page.tsx` writes this same shape into `MY_DASHBOARDS_KEY` and must be kept
 * in step — it hands the cache a `DashboardSummary` straight off the DAO, which spells them the old way.
 */
export interface DashboardSummaryDTO {
  id: string; // opaque `db_…` dashboard id
  name: string | null;
  slug: string | null;
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
 * The signed-in user's composition dashboards (`GET /api/v4/dashboards`) — powers the header dashboard
 * switcher. User config that the user mutates from the same surface, so cache briefly and invalidate
 * explicitly after create/rename/delete; also refetch on focus to catch edits from another tab.
 * Disabled in the read-only shared view (`?access=`), which has no real auth.
 */
export function myDashboardsQuery(enabled = true) {
  return queryOptions({
    queryKey: MY_DASHBOARDS_KEY,
    queryFn: () => fetchJson<MyDashboardsResponse>("/api/v4/dashboards"),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
