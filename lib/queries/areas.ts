import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import type { ReadableArea } from "@/lib/areas/list";

export interface ReadableAreasResponse {
  areas: ReadableArea[];
}

/**
 * The Areas the signed-in user may read (`/api/areas/readable`) — powers the multi-area card picker
 * and the client-side areaId→systemId+label resolution. Org config, so it rarely changes; cache it
 * for the session (no polling). Disabled in the read-only shared view, which carries its referenced
 * areas inline instead.
 */
export function readableAreasQuery(enabled = true) {
  return queryOptions({
    queryKey: ["areas", "readable"],
    queryFn: () => fetchJson<ReadableAreasResponse>("/api/areas/readable"),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
