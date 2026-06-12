/**
 * Freshness policy — the single place that encodes "how live is this data".
 *
 * The user's model:
 *   - latest live values & today's in-progress chart  → refetch eagerly (low latency).
 *   - once a 5-minute / 1-day interval is settled it rarely changes  → an explicit past
 *     window is effectively immutable: `staleTime: Infinity`, no polling.
 *   - Amber is the exception: its PAST intervals get retroactively upgraded
 *     (forecast→actual→billable) over a multi-day window, so Amber is "settled but
 *     mutable" — short staleTime + a boundary-aligned refetch.
 */

import { getNextMinuteBoundary } from "@/lib/date-utils";

export type Interval = "5m" | "30m" | "1d";

// staleTime tiers
export const LIVE_STALE = 25_000; // latest values
export const CHART_STALE = 60_000; // today's in-progress chart (live tail)
export const DAILY_STALE = 5 * 60_000; // 30D daily, live tail
export const AMBER_STALE = 0; // settled-but-mutable: always allow a refetch
export const SETTLED_STALE = Infinity; // explicit past window — immutable

// Boundary-aligned refetch bounds
const GRACE_MS = 15_000; // wait 15s past the boundary so the new interval has materialized
const MIN_MS = 1_000;
const MAX_MS = 5 * 60_000;

export function intervalMinutes(interval: Interval): number {
  if (interval === "5m") return 5;
  if (interval === "30m") return 30;
  return 24 * 60;
}

/**
 * A `refetchInterval` function that fires shortly after each wall-clock interval
 * boundary (+15s grace), then self-reschedules — RQ re-invokes it after every fetch.
 * This replaces the bespoke recursive `scheduleNextFetch` timer.
 */
export function boundaryRefetchInterval(
  intervalMins: number,
  timezoneOffsetMin = 600,
): () => number {
  return () => {
    const nextMs = getNextMinuteBoundary(intervalMins, timezoneOffsetMin)
      .toDate()
      .getTime();
    const ms = nextMs - Date.now() + GRACE_MS;
    return Math.min(MAX_MS, Math.max(MIN_MS, ms));
  };
}

/**
 * Amber's quality-upgrade window. A window whose end is older than this (relative to
 * now) is beyond the reach of retroactive upgrades and can be treated as immutable.
 * The admin sync UI caps backfill at 7 days, so 8 days is a safe horizon.
 */
export const AMBER_SETTLE_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
