"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavigatorPeriod } from "@/lib/charts/temporal";

/** A temporal window as fed to the chart data queries (the navigator's decoded URL state). */
export interface SettledWindow {
  period: NavigatorPeriod;
  start?: string;
  end?: string;
}

function windowKey(w: SettledWindow): string {
  return `${w.period}|${w.start ?? ""}|${w.end ?? ""}`;
}

/**
 * Single-flight + latest-wins committer for the temporal navigator's data fetch.
 *
 * The navigator LABEL follows the URL instantly (see {@link "./useTemporalRange"}); the expensive
 * chart fetch must not — otherwise a rapid click-burst fires one request per click. This returns the
 * window to actually fetch (`committed`), advancing it toward the user's latest `desired` window
 * under two rules:
 *
 *   1. A short trailing debounce coalesces a continuous burst, so the chart body doesn't scrub
 *      through every intermediate day (the label still does — that's the point).
 *   2. It advances ONLY while no fetch is in flight. While one runs it holds; when that fetch
 *      settles it jumps to the *latest* desired window, dropping every window the user clicked
 *      straight past. So there is ever at most ONE request in flight, regardless of click cadence or
 *      network speed — we can't DoS ourselves, and skipped days are never requested. This paces to
 *      the network rather than to a fixed timer, so it also covers sustained ~500ms-apart clicking
 *      that a plain debounce would miss.
 *
 * Wiring — the consuming `useQuery` owns `isFetching`, which the committer needs, so it's reported
 * back after the query is declared:
 *
 *   const desired = useMemo(() => ({ period, start, end }), [period, start, end]);
 *   const [committed, reportFetching] = useSettledWindow(desired);
 *   const q = useQuery(fooQuery({ ...committed }));
 *   useEffect(() => reportFetching(q.isFetching), [q.isFetching, reportFetching]);
 *
 * `desired` MUST be referentially stable across renders where its contents are unchanged (wrap it in
 * `useMemo`), so the internal debounce timer isn't reset on every render.
 */
export function useSettledWindow(
  desired: SettledWindow,
  { debounceMs = 250 }: { debounceMs?: number } = {},
): [SettledWindow, (fetching: boolean) => void] {
  // Trailing debounce of the desired window — only settles once the user pauses for `debounceMs`.
  const [debounced, setDebounced] = useState(desired);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(desired), debounceMs);
    return () => clearTimeout(id);
  }, [desired, debounceMs]);

  const [committed, setCommitted] = useState(desired);
  const [fetching, setFetching] = useState(false);

  // Advance the committed window toward the debounced desired, but only when idle. When a fetch is
  // in flight we hold; the moment it settles this re-runs and jumps straight to the latest debounced
  // window (skipping intermediates). setting committed === debounced makes it a stable fixed point.
  useEffect(() => {
    if (!fetching && windowKey(committed) !== windowKey(debounced)) {
      setCommitted(debounced);
    }
  }, [fetching, debounced, committed]);

  const reportFetching = useCallback((f: boolean) => setFetching(f), []);

  // Keep the returned window referentially stable while its contents are unchanged, so downstream
  // query-key derivation and memoised chart work don't churn.
  const committedKey = windowKey(committed);
  const stableCommitted = useMemo(
    () => committed,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the identity we care about
    [committedKey],
  );

  return [stableCommitted, reportFetching];
}
