"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import type { ChartTimeRange } from "@/lib/charts/scaffold";
import {
  decodeRangeFromParams,
  computeOlder,
  computeNewer,
  encodeRangeToParams,
  type TemporalRange,
} from "@/lib/charts/temporal";

export interface UseTemporalRange extends TemporalRange {
  /** Step back one whole period (prev / ArrowLeft). */
  older: () => void;
  /** Step forward one whole period, reverting to the latest window (next / ArrowRight). No-op at latest. */
  newer: () => void;
  /** Switch period and reset to the latest window (live for D/W; calendar default ending yesterday for M/Y). */
  setPeriod: (period: ChartTimeRange) => void;
}

/**
 * The single read/write façade over the temporal-navigator URL state (`?period`/`?start`/`?end`/
 * `?offset`). The URL is the source of truth — `useSearchParams()` is reactive, so every consumer
 * (each chart + each navigator instance) re-derives the same range and stays in sync; the actions
 * are pure functions of the current URL, so concurrent firings converge on one navigation.
 *
 * `timezoneOffsetMin` drives the calendar math when DECODING (M/Y windows are built in the area-local
 * calendar) as well as when encoding prev/next windows. M/Y are always windowed, but their LATEST
 * state is a param-free URL (`isLatest`), so a shared latest link auto-advances as days pass.
 *
 * Every instance on a page shares the SAME URL params — a component whose period set differs from
 * the shared D/W/M/Y set must NOT use this hook (a foreign `?period=` value collapses to "D",
 * silently corrupting any co-located consumer's window). Give it self-contained local state instead
 * (see `BatteryProvenancePanel`'s doc comment for the incident this note is based on).
 */
export function useTemporalRange({
  timezoneOffsetMin,
}: {
  timezoneOffsetMin: number;
}): UseTemporalRange {
  const searchParams = useSearchParams();

  // Reactive range for rendering (the label, the newer-button disabled state). Re-derives on
  // every URL change — including our own `window.history.pushState` below, which Next syncs
  // into `useSearchParams()`.
  const range = useMemo(
    () => decodeRangeFromParams(searchParams, timezoneOffsetMin),
    [searchParams, timezoneOffsetMin],
  );

  // Shallow client-side URL write via the native History API: NO server round-trip (the
  // dashboard RSC reads only `?access`), so `useSearchParams()` — and therefore every
  // navigator's label — updates IMMEDIATELY on click instead of after the fetch/redraw commits.
  const push = useCallback((params: URLSearchParams) => {
    window.history.pushState(null, "", `?${params.toString()}`);
  }, []);

  // The step actions read the LIVE URL synchronously (`pushState` updates
  // `window.location.search` synchronously) rather than the memoised `range`, so a rapid burst
  // of clicks COMPOUNDS — each click steps from the URL the previous click just wrote, without
  // waiting for React to re-render. Still pure functions of the current URL, so concurrent
  // firings across multiple navigator instances converge on one step.
  const older = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    const current = decodeRangeFromParams(params, timezoneOffsetMin);
    const next = computeOlder(current, timezoneOffsetMin);
    push(
      encodeRangeToParams(params, next, {
        period: current.period,
        timezoneOffsetMin,
      }),
    );
  }, [timezoneOffsetMin, push]);

  const newer = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    const current = decodeRangeFromParams(params, timezoneOffsetMin);
    const next = computeNewer(current, timezoneOffsetMin);
    if (!next) return;
    push(
      encodeRangeToParams(params, next, {
        period: current.period,
        timezoneOffsetMin,
      }),
    );
  }, [timezoneOffsetMin, push]);

  const setPeriod = useCallback(
    (period: ChartTimeRange) => {
      const params = new URLSearchParams(window.location.search);
      push(
        encodeRangeToParams(params, "live", {
          period,
          timezoneOffsetMin,
        }),
      );
    },
    [timezoneOffsetMin, push],
  );

  return { ...range, older, newer, setPeriod };
}
