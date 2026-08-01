/**
 * Plot-area layout and scales — the numbers every SVG chart needs before it can draw anything.
 *
 * Deliberately returns *numbers and d3 scales*, not components. Each chart owns its own `<svg>` and
 * decides what to put in it (docs/plans/chart-library-consolidation.md, Stage 4 decision 3): with
 * only three real consumers there is not enough evidence to know what a chart component's props
 * should be, but there is no doubt about what a scale is. A wrong number is a bug you can unit-test;
 * a wrong component is a refactor.
 */
import {
  scaleLinear,
  scaleTime,
  type ScaleLinear,
  type ScaleTime,
} from "d3-scale";

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Room for the axis furniture around the plot area.
 *
 * `bottom` fits two lines of tick label (W and M stack `[weekday, date]`), so the axis does not
 * reflow between periods — a chart that changed height when you clicked D→W would be worse than a
 * few wasted pixels on D.
 */
export const DEFAULT_MARGIN: ChartMargin = {
  top: 8,
  right: 44,
  bottom: 34,
  left: 44,
};

export interface PlotBox {
  /** Inner drawing area, excluding the margins. */
  width: number;
  height: number;
  /** Offset of the inner area within the svg — the `<g>` transform. */
  left: number;
  top: number;
  /** Inner-area edges in plot coordinates, for spanning gridlines and bands. */
  right: number;
  bottom: number;
}

export interface ChartGeometry {
  plot: PlotBox;
  x: ScaleTime<number, number>;
  y: ScaleLinear<number, number>;
  /** Present only when the chart asked for a right-hand axis. */
  y1?: ScaleLinear<number, number>;
  /** True when the box is too small to draw into — callers should render nothing. */
  empty: boolean;
}

export interface GeometryInput {
  width: number;
  height: number;
  xDomain: [Date, Date];
  yDomain: [number, number];
  y1Domain?: [number, number];
  margin?: Partial<ChartMargin>;
}

/**
 * Build the plot box and scales.
 *
 * Pure — no DOM, no refs — so a chart's geometry can be asserted directly in a unit test rather than
 * inferred from a screenshot. `empty` is set rather than throwing, because a zero-width container is
 * the normal first render before `ResizeObserver` reports (see `useContainerSize`), not an error.
 */
export function buildGeometry(input: GeometryInput): ChartGeometry {
  const margin = { ...DEFAULT_MARGIN, ...input.margin };
  const width = Math.max(0, input.width - margin.left - margin.right);
  const height = Math.max(0, input.height - margin.top - margin.bottom);

  const plot: PlotBox = {
    width,
    height,
    left: margin.left,
    top: margin.top,
    right: width,
    bottom: height,
  };

  const x = scaleTime().domain(input.xDomain).range([0, width]);
  // Inverted range: SVG y grows downward, so the domain maximum sits at pixel 0.
  //
  // `.nice()` matters and is not cosmetic: without it `scale.ticks()` picks round numbers strictly
  // INSIDE the padded domain, so the topmost gridline can sit below the data and the series runs off
  // past the last labelled tick. Snapping the domain out to tick boundaries is what Chart.js did
  // implicitly, and it is also what puts the unit label at the top of the plot rather than adrift.
  const y = scaleLinear().domain(input.yDomain).range([height, 0]).nice();
  const y1 = input.y1Domain
    ? scaleLinear().domain(input.y1Domain).range([height, 0]).nice()
    : undefined;

  return { plot, x, y, y1, empty: width <= 0 || height <= 0 };
}

/**
 * A "nice" y domain for a set of series: zero-anchored where the data allows, padded at the top.
 *
 * Chart.js did this implicitly and it is easy to forget the two cases that matter — a series that
 * goes negative (battery power charging, grid export) must keep its negative room, and an all-zero
 * or empty series must still produce a non-degenerate domain or the scale collapses.
 */
export function niceDomain(
  values: ReadonlyArray<number | null | undefined>,
  opts: { suggestedMax?: number; padFraction?: number } = {},
): [number, number] {
  const { suggestedMax, padFraction = 0.05 } = opts;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) {
    // No finite data at all.
    return [0, suggestedMax ?? 1];
  }

  // Anchor at zero unless the data genuinely goes below it.
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (suggestedMax != null) hi = Math.max(hi, suggestedMax);

  if (hi === lo) return [lo, lo + 1]; // all-zero / single-value: keep the scale non-degenerate

  const pad = (hi - lo) * padFraction;
  hi += pad;
  if (lo < 0) lo -= pad;
  return [lo, hi];
}
