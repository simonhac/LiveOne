"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { siteDataQuery } from "@/lib/queries/siteData";
import {
  computeOlder,
  computeNewer,
  type ChartTimeRange,
  type TemporalRange,
} from "@/lib/charts/temporal";

/**
 * Warm the temporal navigator's NEIGHBOURING windows into the React Query cache, so pressing
 * prev/next resolves from cache instead of paying a round trip.
 *
 * Why this exists: `/api/history`'s server time is now ~90 ms warm, but week-by-week navigation
 * touches a NEW window every click, and each one is a Postgres buffer-cache miss on
 * `point_readings_agg_5m` (measured 2026-09-01: ~65 ms warm vs 200–340 ms cold, and the table is
 * ~15× larger than `shared_buffers`, so a historical week can never be resident). That cost is
 * unavoidable per window — but it does not have to be on the critical path of a click. Prefetching
 * the window the user is most likely to ask for next moves it off.
 *
 * Direction: OLDER is prefetched first and always — "keep pressing ←" is the observed navigation
 * pattern (nine consecutive weeks in the reported trace). Newer is prefetched too, but only when
 * it exists (`computeNewer` returns null at the live window) and only after older, so the two never
 * contend for the same connection.
 *
 * Discipline, all deliberate:
 *  - **Only settled windows.** A live window (`isLatest` with no explicit range) polls on a boundary
 *    interval; prefetching it would duplicate a query that already refetches itself.
 *  - **Idle-scheduled**, via `requestIdleCallback` where available, so it never competes with the
 *    render of the window the user is actually looking at.
 *  - **`prefetchQuery`, not `fetchQuery`** — it no-ops when the key is already cached and fresh, so
 *    walking back through weeks re-warms only the genuinely new edge each time.
 *  - **Cancelled on change.** Navigating again before the prefetch fires aborts the scheduled work;
 *    an in-flight fetch is left alone (React Query dedupes it against the real query if the user
 *    lands there anyway).
 *  - Errors are swallowed: a failed prefetch must never surface to the user, who did not ask for it.
 *
 * Cost: one extra background request per settled window viewed, of the same shape the user's next
 * click would have made anyway.
 */
export function useNeighbourPrefetch({
  systemId,
  range,
  timezoneOffsetMin,
  enabled,
}: {
  systemId: string | number;
  /** The committed (not desired) window — prefetch relative to what is actually on screen. */
  range: {
    period: ChartTimeRange;
    start?: string;
    end?: string;
    isLatest: boolean;
  };
  timezoneOffsetMin: number;
  enabled: boolean;
}): void {
  const queryClient = useQueryClient();
  const { period, start, end, isLatest } = range;

  useEffect(() => {
    // A live/latest window is self-refreshing; there is no settled neighbour worth warming from it
    // in the "newer" direction, and the "older" one is only meaningful once a window is explicit.
    if (!enabled || !systemId) return;

    let cancelled = false;

    const asTemporal: TemporalRange = {
      period,
      start,
      end,
      isHistoricalMode: !!(start && end),
      isLatest,
    };

    const run = async () => {
      const targets: { start: string; end: string }[] = [];
      try {
        targets.push(computeOlder(asTemporal, timezoneOffsetMin));
      } catch {
        // A window we cannot step back from (mangled params) simply gets no prefetch.
      }
      try {
        const newer = computeNewer(asTemporal, timezoneOffsetMin);
        // `computeNewer` returns "live" (or null) at the newest window — neither is a settled
        // window worth warming, and the live query polls itself.
        if (newer && newer !== "live" && typeof newer === "object")
          targets.push(newer as { start: string; end: string });
      } catch {
        /* same */
      }

      for (const t of targets) {
        if (cancelled) return;
        try {
          await queryClient.prefetchQuery(
            siteDataQuery({
              systemId,
              period,
              start: t.start,
              end: t.end,
              timezoneOffsetMin,
            }),
          );
        } catch {
          // Never surface a prefetch failure — the user did not ask for this window.
        }
      }
    };

    // Schedule off the critical path. `requestIdleCallback` is unavailable in Safari < 17, so fall
    // back to a short timeout — the point is only "after the current window has rendered".
    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (
          cb: () => void,
          o?: { timeout: number },
        ) => number;
        cancelIdleCallback?: (id: number) => void;
      }
    ).requestIdleCallback;
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (ric) idleId = ric(() => void run(), { timeout: 2000 });
    else timeoutId = setTimeout(() => void run(), 300);

    return () => {
      cancelled = true;
      const cic = (
        globalThis as unknown as { cancelIdleCallback?: (id: number) => void }
      ).cancelIdleCallback;
      if (idleId !== undefined && cic) cic(idleId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [
    queryClient,
    systemId,
    period,
    start,
    end,
    isLatest,
    timezoneOffsetMin,
    enabled,
  ]);
}
