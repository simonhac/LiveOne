import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import type { DashboardDescriptor } from "@/lib/dashboard/descriptor";

export interface DashboardDescriptorResponse {
  descriptor: DashboardDescriptor | null;
}

/**
 * The user's saved dashboard descriptor for a system (P2), or `{ descriptor: null }` when none is
 * saved (→ the caller falls back to buildDefaultDescriptor). User config, so it never goes stale on
 * its own; it's invalidated explicitly after a save/reset.
 */
export function dashboardDescriptorQuery(systemId: string) {
  return queryOptions({
    queryKey: ["dashboard-descriptor", systemId],
    queryFn: () =>
      fetchJson<DashboardDescriptorResponse>(`/api/dashboard/${systemId}`),
    enabled: !!systemId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
