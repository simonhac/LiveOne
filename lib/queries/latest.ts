import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import { LIVE_STALE } from "./freshness";

export interface LatestReadingValue {
  value?: number | string | boolean;
  physicalPath: string;
  logicalPath: string | null;
  pointReference?: string;
  measurementTime?: string; // ISO8601 string (kept as string — converted at render)
  receivedTime?: string;
  metricUnit: string;
  pointName: string;
  sessionId?: string;
  sessionLabel?: string;
  /** Central display registry: display unit + Excel number format (absent when uncovered). */
  displayUnit?: string;
  displayFormat?: string;
}

interface LatestReadingsResponse {
  values?: LatestReadingValue[];
}

/** `/api/data?include=readings` carries the detailed readings array as `readings`. */
interface DataReadingsResponse {
  readings?: LatestReadingValue[];
}

/**
 * Raw latest readings table — `/api/data?include=readings` → `readings: [...]`, mapped to
 * `{ values }` for the table. `/api/data` is the single producer of the KV latest cache (the former
 * `/api/system/{id}/latest` route was folded in). Low-latency path — same 30s/focus cadence as the
 * dashboard payload, and a manual Poll-Now invalidates `['latest', systemId]`.
 */
export function latestReadingsQuery(
  systemId: SystemIdLike,
  { paused = false }: { paused?: boolean } = {},
) {
  return queryOptions({
    queryKey: queryKeys.latest(systemId),
    queryFn: async (): Promise<LatestReadingsResponse> => {
      const resp = await fetchJson<DataReadingsResponse>(
        `/api/data?systemId=${systemId}&include=readings`,
      );
      return { values: resp.readings ?? [] };
    },
    staleTime: LIVE_STALE,
    refetchInterval: paused ? false : 30_000,
    refetchOnWindowFocus: !paused,
  });
}
