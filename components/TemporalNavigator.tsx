"use client";

import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PeriodSwitcher from "@/components/PeriodSwitcher";
import { formatDateTimeRange } from "@/lib/fe-date-format";
import { fromUnixTimestamp } from "@/lib/date-utils";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration } from "@/lib/charts/temporal";

interface TemporalNavigatorProps {
  /** System/area timezone offset (minutes) — used to format the range label and encode prev/next URLs. */
  timezoneOffsetMin: number;
  /**
   * When set, the label shows this chart's hovered timestamp instead of the window range. Kept local
   * to each chart (each navigator instance receives its own chart's hover), so the navigator never
   * needs a cross-chart hover bus. Empty string / null ⇒ show the range.
   */
  hoverLabel?: string | null;
  /** Disables keyboard stepping while the chart's data is loading. */
  loading?: boolean;
  className?: string;
}

/**
 * The shared temporal navigator: a date-range label + prev/next buttons + the 1D/7D/30D switcher.
 * Self-wired to the URL via {@link useTemporalRange}, so multiple instances on a page (one per chart)
 * all read and write the same shared period + window. Rendered in each chart's header.
 */
export default function TemporalNavigator({
  timezoneOffsetMin,
  hoverLabel,
  loading = false,
  className = "",
}: TemporalNavigatorProps) {
  const { period, start, end, isHistoricalMode, older, newer, setPeriod } =
    useTemporalRange({ timezoneOffsetMin });

  // Keyboard navigation: ArrowLeft = older, ArrowRight = newer (historical only). Safe with multiple
  // navigator instances — older/newer are pure functions of the current URL, so concurrent firings
  // compute the same target and push the same URL (one step, no double-stepping).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        if (!loading) {
          e.preventDefault();
          e.stopPropagation();
          older();
        }
      } else if (e.key === "ArrowRight") {
        if (isHistoricalMode && !loading) {
          e.preventDefault();
          e.stopPropagation();
          newer();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loading, isHistoricalMode, older, newer]);

  // Range label from the requested window (or the live trailing window ending at now). Computed from
  // the shared range — identical across every navigator instance on the page.
  const rangeLabel = (() => {
    const nowMs = Date.now();
    const startMs = start
      ? Date.parse(start)
      : nowMs - getPeriodDuration(period);
    const endMs = end ? Date.parse(end) : nowMs;
    const startZdt = fromUnixTimestamp(startMs / 1000, timezoneOffsetMin);
    const endZdt = fromUnixTimestamp(endMs / 1000, timezoneOffsetMin);
    return {
      desktop: formatDateTimeRange(startZdt, endZdt, period !== "30D"),
      mobile: formatDateTimeRange(startZdt, endZdt, false),
    };
  })();

  return (
    <div className={`flex justify-end items-center ${className}`}>
      <div className="flex items-center gap-2 sm:gap-4">
        <span
          className="text-xs sm:text-sm text-gray-400"
          style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
        >
          {hoverLabel ? (
            hoverLabel
          ) : (
            <>
              <span className="hidden sm:inline">{rangeLabel.desktop}</span>
              <span className="sm:hidden">{rangeLabel.mobile}</span>
            </>
          )}
        </span>
        {/* Prev/Next navigation buttons */}
        <div className="inline-flex rounded-md shadow-sm" role="group">
          <button
            onClick={older}
            className="px-2 py-1 text-sm font-medium border rounded-l-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white transition-none"
            title="Older (Previous)"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={newer}
            disabled={!isHistoricalMode}
            className="px-2 py-1 text-sm font-medium border-l-0 border rounded-r-lg bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-none"
            title="Newer (Next)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <PeriodSwitcher value={period} onChange={setPeriod} />
      </div>
    </div>
  );
}
