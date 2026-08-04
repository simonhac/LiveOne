import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys } from "./keys";
import { LIVE_STALE } from "./freshness";
import type { CommandLogEntryJson } from "@/lib/control/command-log";

export interface CommandLogResponse {
  commands: CommandLogEntryJson[];
}

/**
 * A device's command history, addressed by one of its points —
 * `GET /api/v4/points/{pt_}/commands` (the activity log behind the charge-control dialog).
 *
 * LIVE cadence like `chargeAutomationsQuery`: the evaluator can append a row any minute, and the
 * user's own presses should appear as soon as their mutation invalidates this key.
 *
 * ⚠️ The route is device-OWNER gated, so callers must AND-in their own control gate (and, for
 * the collapsible log, their expanded state): firing it for a viewer earns a guaranteed 403
 * that React Query would then retry.
 */
export function commandLogQuery(pointId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.commands(pointId ?? ""),
    queryFn: () =>
      fetchJson<CommandLogResponse>(
        `/api/v4/points/${encodeURIComponent(pointId ?? "")}/commands?limit=20`,
      ),
    staleTime: LIVE_STALE,
    refetchInterval: 30_000,
    enabled: !!pointId,
  });
}
