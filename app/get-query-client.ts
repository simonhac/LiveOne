import { QueryClient, isServer } from "@tanstack/react-query";

/**
 * Build a QueryClient with the app-wide defaults.
 *
 * Freshness is mostly decided per-query by the factories in `lib/queries/` — these
 * are just the fallbacks for anything that doesn't override them. We default
 * `staleTime` above 0 so a freshly-mounted component doesn't immediately refetch
 * data another component already has cached.
 *
 * This is the forward-compatible base for an SSR prefetch/hydration follow-up:
 * when that lands we only add a `dehydrate.shouldDehydrateQuery` pending rule here.
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

/**
 * Server: always a fresh client (no cross-request sharing).
 * Browser: a singleton, so the cache survives re-renders and is shared across
 * routes — required for cross-route `invalidateQueries` (e.g. Amber-Sync on its
 * own route invalidating the dashboard's queries).
 */
export function getQueryClient(): QueryClient {
  if (isServer) {
    return makeQueryClient();
  }
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
