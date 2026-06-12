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
}

interface LatestReadingsResponse {
  values?: LatestReadingValue[];
}

/**
 * Raw latest readings table: `/api/system/{id}/latest` → `{ values: [...] }`.
 * Low-latency path — same 30s/focus cadence as the dashboard payload.
 */
export function latestReadingsQuery(
  systemId: SystemIdLike,
  { paused = false }: { paused?: boolean } = {},
) {
  return queryOptions({
    queryKey: queryKeys.latest(systemId),
    queryFn: () =>
      fetchJson<LatestReadingsResponse>(`/api/system/${systemId}/latest`),
    staleTime: LIVE_STALE,
    refetchInterval: paused ? false : 30_000,
    refetchOnWindowFocus: !paused,
  });
}
