/**
 * Gap-aware line, area and stack path generation.
 *
 * This is the part of the port the plan calls the hard one, and the reason is null handling. Chart.js
 * expressed "the sensor was down here" through `spanGaps: false` plus `Filler`; d3 expresses it
 * through `.defined()`. They agree on lines and disagree on stacks, so the semantics are pinned here
 * with tests rather than discovered later from a screenshot.
 *
 * ## The rule for stacks
 *
 * A stacked chart has to answer "what does a null mean for the series *above* it?". Treating null as
 * zero silently invents a reading and slides every band above it downward — a data outage would look
 * like a genuine trough. So a null punches a hole through the whole column: every band breaks at that
 * x, and the baseline resumes when data does. That is the honest rendering and it matches what the
 * Chart.js charts do today, where `spanGaps: false` breaks each filled series at the same index.
 */
import {
  area,
  curveLinear,
  curveStepAfter,
  line,
  stack,
  stackOffsetNone,
  stackOrderNone,
  type CurveFactory,
} from "d3-shape";
import type { ScaleLinear, ScaleTime } from "d3-scale";

export type Scale = ScaleLinear<number, number> | ScaleTime<number, number>;

/**
 * Interpolation between points.
 *
 * `stepAfter` is not decoration: a value that HOLDS for an interval — a per-minute count, an applied
 * reserve floor that changes once a day — is misrepresented by a sloped line, which implies readings
 * between the samples that were never taken. It is also what makes a dense series render like
 * touching bars without emitting one node per bar.
 */
export type CurveKind = "linear" | "stepAfter";

const CURVES: Record<CurveKind, CurveFactory> = {
  linear: curveLinear,
  stepAfter: curveStepAfter,
};

/**
 * `d` for a line through `values`, broken wherever a value is null.
 *
 * Returns null (not `""`) when nothing is drawable, so a caller can skip the `<path>` entirely rather
 * than emitting an empty one — an empty `d` is a DOM node that assertions have to special-case.
 */
export function linePath(
  timestamps: readonly Date[],
  values: readonly (number | null | undefined)[],
  x: ScaleTime<number, number>,
  y: ScaleLinear<number, number>,
  curve: CurveKind = "linear",
): string | null {
  const gen = line<number>()
    .curve(CURVES[curve])
    .defined((_, i) => {
      const v = values[i];
      return v != null && Number.isFinite(v);
    })
    .x((_, i) => x(timestamps[i]))
    .y((_, i) => y(values[i] as number));

  const indices = timestamps.map((_, i) => i);
  return gen(indices) || null;
}

/**
 * `d` for a filled band between `lower` and `upper`, broken wherever either bound is null.
 *
 * Used for the SoC min/max range in energy mode. Both bounds must be present for a point to be
 * drawable — half a band is worse than no band, because it reads as a real value.
 */
export function bandPath(
  timestamps: readonly Date[],
  lower: readonly (number | null | undefined)[],
  upper: readonly (number | null | undefined)[],
  x: ScaleTime<number, number>,
  y: ScaleLinear<number, number>,
): string | null {
  const gen = area<number>()
    .defined((_, i) => {
      const lo = lower[i];
      const hi = upper[i];
      return (
        lo != null && hi != null && Number.isFinite(lo) && Number.isFinite(hi)
      );
    })
    .x((_, i) => x(timestamps[i]))
    .y0((_, i) => y(lower[i] as number))
    .y1((_, i) => y(upper[i] as number));

  const indices = timestamps.map((_, i) => i);
  return gen(indices) || null;
}

export interface StackedSeries {
  key: string;
  values: readonly (number | null | undefined)[];
}

export interface StackedBand {
  key: string;
  /** Closed area for the band's fill, or null when it has nothing drawable. */
  d: string | null;
  /**
   * OPEN path along the band's upper edge only — what to stroke.
   *
   * 🛑 Never stroke `d`. `area()` emits a CLOSED path (top edge, back along the baseline, `Z`), so
   * stroking it draws the baseline and the vertical end caps too. On a series sitting at zero that
   * renders as a hard line along the axis, and under a series with height it draws a line beneath
   * the fill — neither of which Chart.js did, because `fill: "stack"` + `borderWidth` stroked only
   * the dataset's own line.
   */
  topD: string | null;
}

/**
 * Stack `series` bottom-to-top and return one area path each.
 *
 * `defined` is evaluated across the WHOLE column: if any series is null at an index, every band
 * breaks there. See the module note — the alternative silently invents a zero and makes an outage
 * look like a trough.
 */
export function stackedBands(
  timestamps: readonly Date[],
  series: readonly StackedSeries[],
  x: ScaleTime<number, number>,
  y: ScaleLinear<number, number>,
  curve: CurveKind = "linear",
): StackedBand[] {
  if (series.length === 0) return [];

  const columnDefined = timestamps.map((_, i) =>
    series.every((s) => {
      const v = s.values[i];
      return v != null && Number.isFinite(v);
    }),
  );

  // d3-stack needs numbers, so undefined columns get a placeholder that `.defined()` then discards.
  const rows = timestamps.map((_, i) => {
    const row: Record<string, number> = { __i: i };
    for (const s of series) {
      const v = s.values[i];
      row[s.key] = v != null && Number.isFinite(v) ? (v as number) : 0;
    }
    return row;
  });

  const stacked = stack<Record<string, number>>()
    .keys(series.map((s) => s.key))
    .order(stackOrderNone)
    .offset(stackOffsetNone)(rows);

  const gen = area<[number, number]>()
    .curve(CURVES[curve])
    .defined((_, i) => columnDefined[i])
    .x((_, i) => x(timestamps[i]))
    .y0((dp) => y(dp[0]))
    .y1((dp) => y(dp[1]));

  // The upper edge as its own open path, so callers stroke the boundary rather than the outline.
  // Same `defined` predicate, so a hole breaks the stroke exactly where it breaks the fill.
  const topGen = line<[number, number]>()
    .curve(CURVES[curve])
    .defined((_, i) => columnDefined[i])
    .x((_, i) => x(timestamps[i]))
    .y((dp) => y(dp[1]));

  return stacked.map((layer, idx) => ({
    key: series[idx].key,
    d: gen(layer as unknown as [number, number][]) || null,
    topD: topGen(layer as unknown as [number, number][]) || null,
  }));
}

/**
 * Contiguous runs of drawable indices — the segments a broken line is made of.
 *
 * Exposed because it is what tests and callers actually want to reason about ("this series has three
 * breaks"), and counting `M` commands in a path string to find out is both fragile and unreadable.
 */
export function definedSegments(
  values: readonly (number | null | undefined)[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const ok = v != null && Number.isFinite(v);
    if (ok && start === null) start = i;
    if (!ok && start !== null) {
      out.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) out.push([start, values.length - 1]);
  return out;
}
