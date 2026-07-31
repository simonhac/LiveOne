import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import type { ReadableArea } from "@/lib/areas/list";

export interface ReadableAreasResponse {
  areas: ReadableArea[];
}

/**
 * The Areas the signed-in user may read (`GET /api/v4/areas`) — powers the multi-area card picker
 * and the client-side areaId→systemId+label resolution. Org config, so it rarely changes; cache it
 * for the session (no polling). Disabled in the read-only shared view, which carries its referenced
 * areas inline instead.
 *
 * 🛑 `legacySystemId` is LOAD-BEARING here and the v4 route carries it deliberately. `clientShellResolver`
 * (`components/dashboard/v4/node-view.tsx`) turns it into `shell.handle` — the address every card's
 * `/api/data?systemId=` fetch is made against. `fetchJson<T>` is an unchecked cast, so a v4 route that
 * dropped it would compile clean and render every card as a permanent skeleton, with no error and
 * nothing to grep for. See the header on `app/api/v4/areas/route.ts`.
 */
export function readableAreasQuery(enabled = true) {
  return queryOptions({
    queryKey: ["areas", "readable"],
    queryFn: () => fetchJson<ReadableAreasResponse>("/api/v4/areas"),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
