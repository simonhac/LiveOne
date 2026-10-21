import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys } from "./keys";
import { LIVE_STALE } from "./freshness";
import type { GeneratorHealth } from "@/lib/control/generator-health";

/**
 * What is wrong with an area's generator — the list behind the generator tile's issues chip.
 *
 * Polled once a minute: the slowest of its inputs is the exercise evaluator's minutely tick, so a
 * faster poll would only re-read the same answer. A failure (a share-token viewer, who cannot
 * authenticate to this route) leaves the chip absent rather than erroring the tile.
 */
export function generatorHealthQuery(areaId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.generatorHealth(areaId ?? ""),
    queryFn: () =>
      fetchJson<GeneratorHealth>(
        `/api/v4/areas/${encodeURIComponent(areaId ?? "")}/generator-health`,
      ),
    staleTime: LIVE_STALE,
    refetchInterval: 60_000,
    retry: false,
    enabled: !!areaId,
  });
}
