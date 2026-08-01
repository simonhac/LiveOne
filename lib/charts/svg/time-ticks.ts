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
import type { ChartTimeRange } from "@/lib/charts/temporal";

export interface TimeTick {
  /** Instant the gridline sits at. */
  value: Date;
  /** Label lines, or `null` for a gridline with no label. */
  label: string[] | null;
}

/**
 * Approximate rendered width of a tick label, in px.
 *
 * Estimated from character count rather than measured with `canvas.measureText`, deliberately: this
 * module is pure so it can be unit-tested, and a DOM dependency here would put the tick algorithm
 * back out of reach of tests. 6 px/char is conservative for DM Sans at 10 px (digits ≈5.6, letters
 * ≈5.5), and erring wide only ever thins labels — it can never cause a collision.
 */
const CHAR_PX = 6;

/**
 * Breathing room **per line of label**, not a flat gap.
 *
 * A two-line `[weekday, date]` label is visually heavier than a one-line `HH:mm` of similar width and
 * needs more horizontal separation to stay readable. Calibrated against the densities the canvas
 * charts actually shipped — at an 812 px plot this reproduces D≈13 labels (canvas: 12), W 8 (8),
 * M 8 (8) and Y 13 (13) — while thinning properly on a phone, which the old count-based ladder never
 * did.
 */
const GAP_PER_LINE_PX = 30;

/** Space one labelled tick needs, text plus breathing room. */
function slotPx(lines: string[]): number {
  return Math.max(...lines.map((l) => l.length)) * CHAR_PX +
    GAP_PER_LINE_PX * lines.length;
}

/**
 * Smallest `n` such that labelling every nth candidate fits in `plotWidth`.
 *
 * This replaces the old count-based ladder (`>25 → 4, >20 → 3, else 2`), which was carried over from
 * `buildTimeScale` and ignored width entirely — so a 30-day axis thinned identically on a 900 px
 * desktop and a 360 px phone, where those two-line `[weekday, date]` labels overlap. Density is a
 * property of the space available, not of how many days happen to be in the window.
 */
function fitSkip(
  candidates: number,
  slot: number,
  plotWidth: number,
): number {
  if (candidates <= 1 || plotWidth <= 0) return 1;
  const maxLabels = Math.max(1, Math.floor(plotWidth / slot));
  return Math.max(1, Math.ceil(candidates / maxLabels));
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
  /** Plot-area width in px. Density is fitted to it — see {@link fitSkip}. */
  plotWidth: number,
): TimeTick[] {
  if (windowEnd <= windowStart) return [];

  const interval = intervalFor(range);
  // `.range` is half-open and starts at the first boundary at-or-after windowStart, which is what we
  // want — a gridline exactly on the left edge is drawn by the axis itself.
  const values = interval.range(windowStart, windowEnd);
  if (values.length === 0) return [];

  if (range === "D") {
    // D is the one period that keeps its UNLABELLED gridlines: the canvas genuinely drew them
    // (24 gridlines to 12 labels), so thinning here removes labels, never lines.
    const skip = Math.max(2, fitSkip(values.length, slotPx(["00:00"]), plotWidth));
    return values.map((value, i) => ({
      value,
      label: i % skip === 0 ? [format(value, "HH:mm")] : null,
    }));
  }

  if (range === "Y") {
    const label = (value: Date, i: number) => [
      // Year on January, and on the first tick so a window that never crosses January still says which.
      format(value, value.getMonth() === 0 || i === 0 ? "MMM yy" : "MMM"),
    ];
    // Sized on the COMMON "MMM", not the widest "MMM yy": only January and the first tick carry a
    // year, so estimating on those would thin the whole axis for two labels' sake.
    const skip = fitSkip(values.length, slotPx(["MMM"]), plotWidth);
    return values
      .filter((_, i) => i % skip === 0)
      .map((value, i) => ({ value, label: label(value, i) }));
  }

  // W and M DROP their unlabelled ticks rather than keeping bare gridlines: measured against the
  // Chart.js baselines, a 30-day window drew ~15 gridlines, and keeping all 31 daily ones renders
  // visibly noisier than what it replaces. (D is the exception, above.)
  const skip = fitSkip(values.length, slotPx(["Wed", "30 Jun"]), plotWidth);
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
