import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys } from "./keys";
import { LIVE_STALE } from "./freshness";
import type { CommandLogEntryJson } from "@/lib/control/command-log";

export interface CommandLogResponse {
  commands: CommandLogEntryJson[];
  /** Is there another page behind this one? The route answers it with a +1 row, not a COUNT. */
  hasMore?: boolean;
  offset?: number;
  limit?: number;
}

/**
 * The inline peek under "Last activity" — the newest ONE, and whether there are more.
 *
 * One row, because the peek answers "did my last press land?" and nothing else; the whole trail is
 * one tap away in the "Show more" modal. It was two, which cost this dialog a line it needed on a
 * phone. `hasMore` is what drives that button, so shrinking this makes the button appear sooner
 * rather than hiding anything.
 */
export const INLINE_LOG_LIMIT = 1;
/** One page of the "Show more" modal. The route caps `limit` at 50, so this is its ceiling too. */
export const LOG_PAGE_SIZE = 50;

function logUrl(pointId: string, limit: number, offset: number): string {
  return `/api/v4/points/${encodeURIComponent(pointId)}/commands?limit=${limit}&offset=${offset}`;
}

/**
 * A device's command history, addressed by one of its points —
 * `GET /api/v4/points/{pt_}/commands` (the activity log behind a control dialog).
 *
 * LIVE cadence like `chargeAutomationsQuery`: the evaluator can append a row any minute, and the
 * user's own presses should appear as soon as their mutation invalidates this key.
 *
 * ⚠️ The route is device-OWNER gated, so callers must AND-in their own control gate (and, for
 * the collapsible log, their expanded state): firing it for a viewer earns a guaranteed 403
 * that React Query would then retry.
 */
export function commandLogQuery(
  pointId: string | null | undefined,
  limit: number = INLINE_LOG_LIMIT,
) {
  return queryOptions({
    queryKey: queryKeys.commands(pointId ?? ""),
    queryFn: () =>
      fetchJson<CommandLogResponse>(logUrl(pointId ?? "", limit, 0)),
    staleTime: LIVE_STALE,
    refetchInterval: 30_000,
    enabled: !!pointId,
  });
}

/**
 * The FULL trail, a page at a time — what the "Show more" modal reads.
 *
 * Deliberately a separate key from `commandLogQuery`, not a widening of it: the inline peek stays a
 * five-row fetch on a 30 s refetch for every open dialog, and the cost of the long history is paid
 * only by a reader who asked to see it. It also does not poll — a list you are scrolling should not
 * reorder underneath you every 30 seconds.
 */
export function commandLogPagesQuery(pointId: string | null | undefined) {
  return infiniteQueryOptions({
    queryKey: [...queryKeys.commands(pointId ?? ""), "pages"] as const,
    queryFn: ({ pageParam }) =>
      fetchJson<CommandLogResponse>(
        logUrl(pointId ?? "", LOG_PAGE_SIZE, pageParam),
      ),
    initialPageParam: 0,
    getNextPageParam: (
      last: CommandLogResponse,
      pages: CommandLogResponse[],
    ) => (last.hasMore ? pages.length * LOG_PAGE_SIZE : undefined),
    staleTime: LIVE_STALE,
    enabled: !!pointId,
  });
}
