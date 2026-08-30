"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { ChartTimeRange } from "@/lib/charts/temporal";
import {
  decodeRangeFromParams,
  computeOlder,
  computeNewer,
  encodeRangeToParams,
  PERIOD_LABEL,
  type TemporalRange,
} from "@/lib/charts/temporal";

/**
 * The last set of dropped params we cleaned up, keyed by `param=value`.
 *
 * MODULE-level, not per-instance: this hook is mounted ~8× on one dashboard — `HeaderTemporalNav`
 * twice (the desktop and mobile copies are BOTH in the DOM, only CSS hides one) plus every chart and
 * tile that time-travels. A per-instance guard would fire eight toasts and race eight history writes
 * for a single bad link.
 */
let lastHandledDrop: string | null = null;

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

  // A mangled link (`?start=2026-08-24_00:00` — the format wants a dot, not a colon) used to throw
  // out of the memo above and blank the whole document, since there was no boundary between here and
  // the root. Now the range simply comes back as the default window; here we make the URL agree with
  // what is on screen — strip the params we ignored — and say so once.
  const dropped = range.droppedParams;
  const dropKey = dropped
    ? dropped.map((d) => `${d.param}=${d.value}`).join("&")
    : null;
  useEffect(() => {
    if (!dropped || !dropKey || lastHandledDrop === dropKey) return;
    lastHandledDrop = dropKey;

    const params = new URLSearchParams(window.location.search);
    // The URL may have moved on between render and effect (a navigator click, a Back). Only touch it
    // if the offending values are still the ones in the bar.
    if (!dropped.every((d) => params.get(d.param) === d.value)) return;
    for (const d of dropped) params.delete(d.param);

    // `replaceState`, matching `push` below: shallow, no RSC round-trip, and Next syncs it into
    // `useSearchParams()` so every other consumer re-derives from the cleaned URL. `replace` rather
    // than `push` keeps Back pointing at wherever the user came from, not at the broken URL.
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `?${qs}` : window.location.pathname,
    );

    // The toast announces a LOST WINDOW, so only `start`/`end` earn one. An `?offset` never carries
    // the window on its own: dropped alongside a bad `?start` it is collateral, and dropped alone it
    // just falls back to the area's own timezone — which is the right answer anyway. Either way,
    // saying "“abc” isn't a date, showing the last 24 hours" would be false on both counts.
    const lost = dropped.filter((d) => d.param !== "offset");
    if (!lost.length) return;

    // Deferred by a tick, and that is load-bearing on a cold load: sonner's <Toaster> sits AFTER
    // {children} in the root layout, so React flushes this effect BEFORE the Toaster subscribes —
    // toasting synchronously here publishes to nobody and is silently swallowed. Which is exactly
    // the case that matters: someone opening a mangled link for the first time.
    const named = lost.map((d) => `“${d.value}”`).join(" and ");
    const timer = setTimeout(() => {
      toast.warning("Couldn’t read that link", {
        id: "temporal-param", // sonner-level dedupe, belt and braces over `lastHandledDrop`
        description: `${named} ${lost.length > 1 ? "aren’t dates" : "isn’t a date"} we recognise — showing the last ${PERIOD_LABEL[range.period]} instead.`,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [dropped, dropKey, range.period]);

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
