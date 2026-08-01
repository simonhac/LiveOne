/**
 * Shared d3/SVG chart primitives.
 *
 * This is a toolkit, **not a chart component**. Each chart assembles its own `<svg>` and draws its
 * own series; what lives here is the arithmetic that is fiddly enough to be worth sharing and
 * testing once — scales and plot layout, time-tick selection, gap-aware path generation, pointer
 * hit-testing — plus a handful of presentational pieces for the axis furniture.
 *
 * The rationale for that split is in docs/plans/chart-library-consolidation.md (Stage 4, decision 3):
 * with only three real consumers (the heatmap opts out — categorical axes, no focus line) there is
 * not enough evidence to know what a chart component's props should be, and `SiteChartsCard` at
 * 1,017 lines of interaction is exactly the consumer that would end up fighting one. Numbers are
 * unit-testable; a wrong number is a bug, a wrong component is a refactor.
 */
export {
  buildGeometry,
  niceDomain,
  DEFAULT_MARGIN,
  type ChartGeometry,
  type ChartMargin,
  type GeometryInput,
  type PlotBox,
} from "./geometry";

export { buildTimeTicks, buildShadingBands, type TimeTick } from "./time-ticks";

export {
  bandPath,
  definedSegments,
  linePath,
  stackedBands,
  type StackedBand,
  type StackedSeries,
} from "./paths";

export {
  nearestIndexForTime,
  useContainerSize,
  usePointerIndex,
  type Size,
  type PointerIndexOptions,
} from "./hooks";

export {
  FocusLine,
  ShadingBands,
  TimeAxis,
  ValueAxis,
  type FocusLineProps,
  type ShadingBandsProps,
  type TimeAxisProps,
  type ValueAxisProps,
} from "./axes";
