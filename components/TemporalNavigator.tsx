"use client";

import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PeriodSwitcher from "@/components/PeriodSwitcher";
import { formatDateTimeRange } from "@/lib/fe-date-format";
import { fromUnixTimestamp } from "@/lib/date-utils";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration, isDateOnlyPeriod } from "@/lib/charts/temporal";
import { formatHoverTimestamp } from "@/lib/charts/scaffold";
import { useChartFocus } from "@/lib/charts/ChartFocusContext";

interface TemporalNavigatorProps {
  /** System/area timezone offset (minutes) — used to format the range label and encode prev/next URLs. */
  timezoneOffsetMin: number;
  className?: string;
}

/**
 * The shared temporal navigator: a date-range label + prev/next buttons + the D/W/M/Y switcher.
 * Self-wired to the URL via {@link useTemporalRange}, so multiple instances on a page (one per chart)
 * all read and write the same shared period + window. Rendered in each chart's header.
 *
 * The label shows the window range by default, switching to the hovered time/date whenever a point
 * is focused on ANY chart in the cluster — read from the shared {@link useChartFocus} so every
 * navigator instance shows the identical label, kept in sync across the line chart + site charts.
 */
export default function TemporalNavigator({
  timezoneOffsetMin,
  className = "",
}: TemporalNavigatorProps) {
  const { period, start, end, isLatest, older, newer, setPeriod } =
    useTemporalRange({ timezoneOffsetMin });
  const { focusedTime } = useChartFocus();

  // Keyboard navigation: ArrowLeft = older, ArrowRight = newer (historical only). NOT gated on the
  // fetch state — stepping is a synchronous URL write (see useTemporalRange), so held/rapid arrow
  // keys compound instantly while the data catches up. Safe with multiple navigator instances:
  // older/newer read the live URL, so concurrent firings converge on one step (no double-stepping).
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
        e.preventDefault();
        e.stopPropagation();
        older();
      } else if (e.key === "ArrowRight") {
        if (!isLatest) {
          e.preventDefault();
          e.stopPropagation();
          newer();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLatest, older, newer]);

  // Range label from the requested window (or the live trailing window ending at now). Computed from
  // the shared range — identical across every navigator instance on the page.
  const rangeLabel = (() => {
    const nowMs = Date.now();
    const startMs = start
      ? Date.parse(start)
      : nowMs - getPeriodDuration(period);
    // M/Y carry an INCLUSIVE last day at UTC-midnight, so the end instant already maps to the last
    // included day (no adjustment): M reads "22 Jun – 21 Jul 2026".
    const endMs = end ? Date.parse(end) : nowMs;
    const startZdt = fromUnixTimestamp(startMs / 1000, timezoneOffsetMin);
    const endZdt = fromUnixTimestamp(endMs / 1000, timezoneOffsetMin);
    return {
      desktop: formatDateTimeRange(startZdt, endZdt, !isDateOnlyPeriod(period)),
      mobile: formatDateTimeRange(startZdt, endZdt, false),
    };
  })();

  // Shared hover label: when a point is focused on any chart in the cluster, every navigator shows
  // that instant (period-aware via the shared formatter) instead of the range. Desktop/mobile drop
  // the year to match the range label's responsive width.
  const hoverLabel = focusedTime
    ? {
        desktop: formatHoverTimestamp(focusedTime, period, false),
        mobile: formatHoverTimestamp(focusedTime, period, true),
      }
    : null;

  return (
    <div className={`flex justify-end items-center ${className}`}>
      <div className="flex items-center gap-2 sm:gap-4">
        <span
          className="text-xs sm:text-sm text-gray-400"
          style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
        >
          <span className="hidden sm:inline">
            {hoverLabel ? hoverLabel.desktop : rangeLabel.desktop}
          </span>
          <span className="sm:hidden">
            {hoverLabel ? hoverLabel.mobile : rangeLabel.mobile}
          </span>
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
            disabled={isLatest}
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
