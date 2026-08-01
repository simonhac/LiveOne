/**
 * Time-axis tick selection and labelling for the SVG charts.
 *
 * This replaces `buildTimeScale` (`lib/charts/scaffold.ts`), which could not be ported: nearly all of
 * it is workarounds *for* Chart.js — `autoSkip`, returning five spaces to defeat collision detection,
 * a zero-width space to keep a gridline while hiding its label, multi-line label arrays, and a skip
 * ladder stepping 2→3→4 by tick count. None of those have an equivalent when you choose the tick set
 * yourself, because none of the problems they solve exist.
 *
 * What IS reproduced is the visible result: the same label text, the same formats, and the same
 * rough density per period (docs/plans/chart-library-consolidation.md, Stage 4 decision 4). Ticks may
 * land on slightly different days at M scale than Chart.js happened to pick.
 *
 * ## Gridlines and labels are separate
 *
 * Chart.js drew a gridline at every tick and blanked *labels* it didn't want, which is why those
 * whitespace hacks existed. That distinction is real and is kept honestly here: every entry is a
 * gridline, and `label` is `null` when the tick is unlabelled. Callers render both from one list
 * instead of reconciling two.
 *
 * Labels are `string[]` because W and M stack `[weekday, date]` on two lines.
 */
import {
  timeDay,
  timeHour,
  timeMonth,
  type CountableTimeInterval,
} from "d3-time";
import { format } from "date-fns";
import type { ChartTimeRange } from "@/lib/charts/scaffold";

export interface TimeTick {
  /** Instant the gridline sits at. */
  value: Date;
  /** Label lines, or `null` for a gridline with no label. */
  label: string[] | null;
}

/**
 * How many ticks to skip a label for at M scale.
 *
 * Carried over verbatim from `buildTimeScale`, quirk included: with ~31 daily ticks across a
 * 30-day window this lands on 4, which is the "every 4th day" spacing the current axis shows. It
 * is a density heuristic, not a fitting algorithm — replacing it with measure-to-fit is noted as
 * follow-on work rather than done here.
 */
function monthSkipInterval(tickCount: number): number {
  if (tickCount > 25) return 4;
  if (tickCount > 20) return 3;
  return 2;
}

/** The gridline interval for a period — every tick in the returned list sits on one of these. */
function intervalFor(range: ChartTimeRange): CountableTimeInterval {
  if (range === "D") return timeHour;
  if (range === "Y") return timeMonth;
  return timeDay; // W and M
}

/**
 * Ticks for `[windowStart, windowEnd]`, gridlines and labels together.
 *
 * Per period, matching what the Chart.js axis renders today:
 *  - **D** — hourly gridlines, `HH:mm` on every second one (so labels read 2-hourly).
 *  - **W** — daily gridlines, every one labelled `[EEE, d MMM]` across two lines.
 *  - **M** — gridlines every 2nd/3rd/4th day by count, each labelled `[EEE, d MMM]`. Unlike D, the
 *    skipped days get no gridline at all (see the note at the call site).
 *  - **Y** — monthly gridlines labelled `MMM`, with `MMM yy` on January and on the first tick, so
 *    the reader can always orient without hunting for a year.
 */
export function buildTimeTicks(
  range: ChartTimeRange,
  windowStart: Date,
  windowEnd: Date,
): TimeTick[] {
  if (windowEnd <= windowStart) return [];

  const interval = intervalFor(range);
  // `.range` is half-open and starts at the first boundary at-or-after windowStart, which is what we
  // want — a gridline exactly on the left edge is drawn by the axis itself.
  const values = interval.range(windowStart, windowEnd);
  if (values.length === 0) return [];

  if (range === "D") {
    return values.map((value, i) => ({
      value,
      label: i % 2 === 0 ? [format(value, "HH:mm")] : null,
    }));
  }

  if (range === "Y") {
    return values.map((value, i) => ({
      value,
      // Year on January, and on the first tick so a window that never crosses January still says which.
      label: [
        format(value, value.getMonth() === 0 || i === 0 ? "MMM yy" : "MMM"),
      ],
    }));
  }

  // W labels every daily tick. M thins by count and DROPS the unlabelled ticks entirely rather than
  // keeping bare gridlines: measured against the Chart.js baselines, a 30-day window drew ~15
  // gridlines, and keeping all 31 daily ones renders visibly noisier than what it replaces. D keeps
  // its unlabelled gridlines because there the canvas genuinely draws them (24 gridlines, 12 labels).
  const skip = range === "M" ? monthSkipInterval(values.length) : 1;
  return values
    .filter((_, i) => i % skip === 0)
    .map((value) => ({
      value,
      label: [format(value, "EEE"), format(value, "d MMM")],
    }));
}

/**
 * Background shading bands, as plain `[start, end]` instants clipped to the window.
 *
 * Same semantics as `buildShadingAnnotations`: daytime columns (07:00–22:00) for D and W, weekday
 * columns (Mon–Fri, full day) for M, and nothing for Y — weekday striping is noise at year scale.
 * Returned as intervals rather than chartjs-plugin-annotation box specs; the caller draws `<rect>`s.
 */
export function buildShadingBands(
  range: ChartTimeRange,
  windowStart: Date,
  windowEnd: Date,
): Array<{ start: number; end: number }> {
  if (range === "Y" || windowEnd <= windowStart) return [];

  const lo = windowStart.getTime();
  const hi = windowEnd.getTime();
  const out: Array<{ start: number; end: number }> = [];

  const push = (a: number, b: number) => {
    const start = Math.max(a, lo);
    const end = Math.min(b, hi);
    if (end > start) out.push({ start, end });
  };

  if (range === "M") {
    // Whole weekdays. Walk local midnights across the window; weekends are simply not pushed.
    for (const day of timeDay.range(timeDay.floor(windowStart), windowEnd)) {
      const dow = day.getDay();
      if (dow === 0 || dow === 6) continue;
      push(day.getTime(), timeDay.offset(day, 1).getTime());
    }
    return out;
  }

  // D and W: the 07:00–22:00 daylight column of each local day.
  for (const day of timeDay.range(timeDay.floor(windowStart), windowEnd)) {
    const dayStart = new Date(day);
    dayStart.setHours(7, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(22, 0, 0, 0);
    push(dayStart.getTime(), dayEnd.getTime());
  }
  return out;
}
