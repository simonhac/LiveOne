"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  /** Step forward one whole period, reverting to live near now (next / ArrowRight). No-op in live mode. */
  newer: () => void;
  /** Switch period and reset to the live trailing window. */
  setPeriod: (period: ChartTimeRange) => void;
}

/**
 * The single read/write façade over the temporal-navigator URL state (`?period`/`?start`/`?end`/
 * `?offset`). The URL is the source of truth — `useSearchParams()` is reactive, so every consumer
 * (each chart + each navigator instance) re-derives the same range and stays in sync; the actions
 * are pure functions of the current URL, so concurrent firings converge on one navigation.
 *
 * `timezoneOffsetMin` is used only to encode the local date/offset when writing prev/next windows;
 * decoding uses the offset stored in the URL, so the absolute window round-trips across timezones.
 */
export function useTemporalRange({
  timezoneOffsetMin,
}: {
  timezoneOffsetMin: number;
}): UseTemporalRange {
  const router = useRouter();
  const searchParams = useSearchParams();

  const range = useMemo(
    () => decodeRangeFromParams(searchParams),
    [searchParams],
  );

  const push = useCallback(
    (params: URLSearchParams) => {
      router.push(`?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const older = useCallback(() => {
    const next = computeOlder(range);
    push(
      encodeRangeToParams(searchParams, next, {
        period: range.period,
        timezoneOffsetMin,
      }),
    );
  }, [range, searchParams, timezoneOffsetMin, push]);

  const newer = useCallback(() => {
    const next = computeNewer(range);
    if (!next) return;
    push(
      encodeRangeToParams(searchParams, next, {
        period: range.period,
        timezoneOffsetMin,
      }),
    );
  }, [range, searchParams, timezoneOffsetMin, push]);

  const setPeriod = useCallback(
    (period: ChartTimeRange) => {
      push(
        encodeRangeToParams(searchParams, "live", {
          period,
          timezoneOffsetMin,
        }),
      );
    },
    [searchParams, timezoneOffsetMin, push],
  );

  return { ...range, older, newer, setPeriod };
}
