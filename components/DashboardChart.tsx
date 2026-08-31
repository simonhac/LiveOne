"use client";

import { useId, useMemo } from "react";
import {
  FocusLine,
  ShadingBands,
  TimeAxis,
  ValueAxis,
  bandPath,
  buildGeometry,
  buildShadingBands,
  buildTimeTicks,
  linePath,
  niceDomain,
  stackedBands,
  useContainerSize,
  usePointerIndex,
} from "@/lib/charts/svg";
import { CHART_COLORS } from "@/lib/chart-colors";
import { CHART_INK } from "@/lib/charts/style";
import { SOC_DASH, lineSeries } from "@/lib/charts/line-series";
import { snapToBandEdges, type RunBand } from "@/lib/charts/run-bands";
import type { ChartTimeRange } from "@/lib/charts/temporal";
import type {
  ChartData,
  LineChartData,
  PaddedSOCData,
  SeriesData,
} from "@/lib/charts/types";

/**
 * The presentational dashboard chart. One component, two visual variants — `lines` (overlaid lines,
 * or grouped bars in energy mode; the sidebar chart) and `stacked-areas` (stacked areas, or stacked
 * bars in energy mode; the site load/generation chart). Data ownership and interaction state stay in
 * the cards.
 *
 * Ported off Chart.js in Stage 5 (docs/plans/chart-library-consolidation.md) — the last and highest
 * risk slice, because the stacked variant is where null handling actually bites.
 *
 * Two props from the Chart.js era are gone rather than carried:
 *  - `chartRef` — a `Chart` instance ref both cards created, passed, and never read.
 *  - `onHover(event, activeElements, chart)` — of which only `activeElements[0].index` was ever used.
 *    Now `onHoverIndex(index | null)`, which is also what `ProvenanceChart` takes.
 */

const SOC_DOMAIN: [number, number] = [0, 100];

/**
 * Where a hovered run is, and what to place its panel against — all in the CHART'S OWN coordinates
 * (origin at the top-left of this component's box, which is also the svg's).
 *
 * 🛑 Not viewport coordinates, and not measured with `getBoundingClientRect`. These come straight
 * out of the same `geo` that drew the band, so they are geometry rather than a snapshot of where the
 * page happened to be scrolled to — which is what lets the caller anchor the panel with a plain
 * `position: absolute` and have it travel with the chart for free. Measured viewport coords went
 * stale the moment anything scrolled, and chasing that with a scroll listener is a JS answer to a
 * question CSS already answers.
 *
 * `plot` is the PLOT BOX, not the SVG's: centring on the svg would pull the panel down by half the
 * time-axis gutter, so it would sit visibly low against the data it describes.
 *
 * No pointer position: the panel sits beside the run and centred on the plot, so where in the run
 * the pointer happens to be is not part of the answer.
 */
export interface RunTooltipAnchor {
  x0: number;
  x1: number;
  plot: { left: number; top: number; width: number; height: number };
}

/**
 * Run-period overlay ink.
 *
 * A run is an EVENT worth noticing, not background texture — the distinction `ProvenanceBand` draws
 * for the BMS-recalibration bands, and the reason these are not another pass of `ShadingBands`' 7 %
 * white wash. Two differences follow from it: the overlay is clipped to the band's OWN area rather
 * than running full height (a charge session is a fact about the EV, not about the whole site), and
 * it carries a visible outline at rest so the run can be found without hunting for it with a mouse.
 *
 * The darkening is black rather than a tint of the series colour: it has to read the same way over
 * every band the stack might give it, and it must not become a colour a legend could be looked up by.
 *
 * It is applied as DIAGONAL STRIPES, not a flat wash — half the tile carries the darkening and half
 * is fully transparent. A wash dims the band, which reads as "this data is lesser"; a texture reads
 * as "this region is marked", which is what a run is. Averaged over the tile it is half the ink a
 * flat wash of the same colour would lay down, which is what keeps it subtle.
 */
const RUN_FILL = "rgba(0, 0, 0, 0.14)";
const RUN_FILL_HOVER = "rgba(0, 0, 0, 0.26)";
const RUN_EDGE = "rgba(255, 255, 255, 0.45)";
const RUN_EDGE_HOVER = "rgba(255, 255, 255, 0.95)";
/** Stripe pitch and duty, in px — see `patternUnits` on the pattern for why these are not fractions. */
const RUN_STRIPE_TILE = 8;
const RUN_STRIPE_WIDTH = 4;

type CommonProps = {
  timeRange: ChartTimeRange;
  /** End of the rendered window (the last data timestamp), NOT the wall clock. */
  windowEnd: Date;
  windowStart: Date;
  /** Shared focus instant → the crosshair, synced across the section by ChartFocusContext. */
  hoveredTimestamp: Date | null;
  onHoverIndex: (index: number | null) => void;
  className?: string;
};

type LinesProps = CommonProps & {
  variant: "lines";
  chartData: LineChartData;
  paddedSOCData: PaddedSOCData | null;
  maxPowerHint?: number;
};

type StackedProps = CommonProps & {
  variant: "stacked-areas";
  chartData: ChartData;
  effectiveVisibleSeries: Set<string>;
  mode: "load" | "generation";
  /**
   * Persisted run periods to bracket on their own series' band (EV charge sessions, generator runs).
   * Window-clamped by `runBandsForSeries`; the card owns the fetch and the hover state.
   */
  runBands?: readonly RunBand[];
  hoveredRunId?: string | null;
  /**
   * `at` is the anchor for the card's tooltip, in this chart's own coordinates: the run's left and
   * right edges (so the panel can sit beside the region rather than covering the thing it describes)
   * plus the plot box to place and clamp against. Absent when the hover ends. See
   * {@link RunTooltipAnchor} for why these are not viewport coordinates.
   */
  onHoverRun?: (band: RunBand | null, at?: RunTooltipAnchor) => void;
};

export type DashboardChartProps = LinesProps | StackedProps;

/**
 * Bar geometry for one category.
 *
 * Reproduces Chart.js's `categoryPercentage`/`barPercentage` model rather than inventing spacing: the
 * category gets a slice of the axis, the group takes `categoryPct` of it, and each bar takes `barPct`
 * of its share of the group. Kept local — this is the only chart with bars, so lifting it into the
 * primitives would be a shared abstraction with one consumer.
 */
function barLayout(
  plotWidth: number,
  categories: number,
  seriesCount: number,
  categoryPct: number,
  barPct: number,
) {
  const categoryW = categories > 0 ? plotWidth / categories : 0;
  const groupW = categoryW * categoryPct;
  const slotW = seriesCount > 0 ? groupW / seriesCount : 0;
  return {
    width: Math.max(0.5, slotW * barPct),
    /** Left edge of series `s`'s bar within category `i`. */
    x: (i: number, s: number) =>
      i * categoryW +
      (categoryW - groupW) / 2 +
      s * slotW +
      (slotW * (1 - barPct)) / 2,
  };
}

export default function DashboardChart(props: DashboardChartProps) {
  const {
    timeRange,
    windowStart,
    windowEnd,
    hoveredTimestamp,
    onHoverIndex,
    className,
  } = props;
  const [ref, size] = useContainerSize<HTMLDivElement>();
  // `clipPath` references are document-global, so two charts on one page would otherwise clip each
  // other's run overlays with whichever definition mounted last.
  const clipPrefix = useId().replace(/:/g, "");
  const isEnergy = props.chartData.mode === "energy";
  const timestamps = props.chartData.timestamps;

  const series = useMemo(
    () =>
      props.variant === "lines"
        ? lineSeries(props.chartData)
        : props.chartData.series
            .filter(
              (s: SeriesData) =>
                s.seriesType !== "soc" &&
                props.effectiveVisibleSeries.has(s.id),
            )
            .map((s: SeriesData) => ({
              key: s.id,
              colour: s.color,
              values: s.data,
            })),
    [props],
  );

  const geo = useMemo(() => {
    if (size.width === 0 || size.height === 0) return null;
    // The stacked variant's ceiling is the column TOTAL; the lines variant's is the tallest series.
    const forDomain =
      props.variant === "stacked-areas"
        ? timestamps.map((_, i) =>
            series.reduce((sum, s) => {
              const v = s.values[i];
              return sum + (v != null && Number.isFinite(v) ? v : 0);
            }, 0),
          )
        : series.flatMap((s) => s.values);
    return buildGeometry({
      width: size.width,
      height: size.height,
      xDomain: [windowStart, windowEnd],
      yDomain: niceDomain(forDomain, {
        suggestedMax:
          props.variant === "lines" && !isEnergy
            ? props.maxPowerHint
            : undefined,
      }),
      y1Domain: SOC_DOMAIN,
    });
  }, [
    size.width,
    size.height,
    windowStart,
    windowEnd,
    series,
    timestamps,
    props,
    isEnergy,
  ]);

  const pointer = usePointerIndex({
    timestamps,
    invert: (px) => (geo ? geo.x.invert(px) : new Date(0)),
    plotLeft: geo?.plot.left ?? 0,
    onChange: onHoverIndex,
  });

  // `data-unmeasured` so "the container measured zero, so the chart drew nothing" is visible in
  // devtools. Without it this is an anonymous empty div, which is what made the mobile stacked-chart
  // collapse (a `h-full` box whose parent height came from flex growth) read as missing data.
  if (!geo || geo.empty)
    return <div ref={ref} className={className} data-unmeasured="" />;

  const socSeries =
    props.variant === "stacked-areas"
      ? props.chartData.series.filter((s) => s.seriesType === "soc")
      : [];
  const socLine =
    props.variant === "lines"
      ? props.chartData.batterySOC
      : (socSeries.find((s) => s.description.includes("(Avg)"))?.data ??
        socSeries.find((s) => !s.description.includes("("))?.data ??
        null);
  const socMin =
    props.variant === "lines"
      ? (props.paddedSOCData?.min ?? null)
      : (socSeries.find((s) => s.description.includes("(Min)"))?.data ?? null);
  const socMax =
    props.variant === "lines"
      ? (props.paddedSOCData?.max ?? null)
      : (socSeries.find((s) => s.description.includes("(Max)"))?.data ?? null);
  const socTimestamps =
    props.variant === "lines" && props.paddedSOCData
      ? props.paddedSOCData.timestamps
      : timestamps;

  const bars = isEnergy
    ? barLayout(
        geo.plot.width,
        timestamps.length,
        props.variant === "lines" ? series.length : 1,
        props.variant === "lines" ? 0.8 : 0.95,
        props.variant === "lines" ? 0.9 : 0.95,
      )
    : null;

  const socBand =
    socMin && socMax
      ? bandPath(socTimestamps, socMin, socMax, geo.x, geo.y1!)
      : null;

  // Hoisted out of the JSX so the run overlay can re-use each band's own area path — the overlay IS
  // a slice of the band, so re-deriving it would be a second source of truth for the same geometry.
  // Areas only: in energy mode the stack is daily bars, and a sub-daily run has nothing to bracket.
  const stacked =
    props.variant === "stacked-areas" && !isEnergy
      ? stackedBands(timestamps, series, geo.x, geo.y)
      : null;

  return (
    <div ref={ref} className={className}>
      <svg
        width={size.width}
        height={size.height}
        data-testid={`dashboard-chart-${props.variant}`}
        onPointerMove={pointer.onPointerMove}
        onPointerLeave={pointer.onPointerLeave}
      >
        <g transform={`translate(${geo.plot.left}, ${geo.plot.top})`}>
          <ShadingBands
            bands={buildShadingBands(timeRange, windowStart, windowEnd)}
            x={geo.x}
            plotHeight={geo.plot.height}
          />
          <TimeAxis
            ticks={buildTimeTicks(
              timeRange,
              windowStart,
              windowEnd,
              geo.plot.width,
            )}
            x={geo.x}
            plotHeight={geo.plot.height}
            align={timeRange === "D" ? "center" : "start"}
          />
          <ValueAxis
            scale={geo.y}
            plotWidth={geo.plot.width}
            side="left"
            unit={isEnergy ? "kWh" : "kW"}
          />
          <ValueAxis
            scale={geo.y1!}
            plotWidth={geo.plot.width}
            side="right"
            unit="%"
            // The load chart hides its SoC axis but keeps the layout, as it always has.
            hidden={props.variant === "stacked-areas" && props.mode === "load"}
          />

          {/* The SoC min/max band sits behind everything — it is context, not a reading. */}
          {socBand && (
            <path
              d={socBand}
              fill={CHART_COLORS.battery.socRange}
              stroke="none"
            />
          )}

          {/* Series. Bars in energy mode, otherwise stacked areas or overlaid lines. */}
          {isEnergy && bars
            ? series.map((s, si) =>
                timestamps.map((_, i) => {
                  const v = s.values[i];
                  if (v == null || !Number.isFinite(v)) return null;
                  // Stacked bars accumulate; grouped bars sit side by side.
                  const base =
                    props.variant === "stacked-areas"
                      ? series.slice(0, si).reduce((sum, o) => {
                          const ov = o.values[i];
                          return (
                            sum + (ov != null && Number.isFinite(ov) ? ov : 0)
                          );
                        }, 0)
                      : 0;
                  const y0 = geo.y(base);
                  const y1 = geo.y(base + v);
                  return (
                    <rect
                      key={`${s.key}-${i}`}
                      x={bars.x(i, props.variant === "lines" ? si : 0)}
                      y={Math.min(y0, y1)}
                      width={bars.width}
                      height={Math.abs(y1 - y0)}
                      fill={s.colour}
                      data-series={s.key}
                    />
                  );
                }),
              )
            : stacked
              ? stacked.map((band, i) => (
                  // Fill and stroke are SEPARATE paths. Stroking the filled area would stroke its
                  // closed outline — baseline included — which is not what Chart.js drew.
                  <g key={band.key} data-series={band.key}>
                    {band.d && (
                      <path d={band.d} fill={series[i].colour} stroke="none" />
                    )}
                    {band.topD && (
                      <path
                        d={band.topD}
                        fill="none"
                        stroke={series[i].colour}
                        strokeWidth={CHART_INK.bandEdgeStroke}
                      />
                    )}
                  </g>
                ))
              : series.map((s) => {
                  const d = linePath(timestamps, s.values, geo.x, geo.y);
                  return d ? (
                    <path
                      key={s.key}
                      d={d}
                      fill="none"
                      stroke={s.colour}
                      strokeWidth={CHART_INK.seriesStroke}
                      data-series={s.key}
                    />
                  ) : null;
                })}

          {/* Run periods, bracketed on their own band. Above the series (it darkens them) and below
              the focus line (a crosshair the overlay could hide would be worse than one it crosses).

              THE OUTLINE IS TWO CLIPS, MUTUALLY. The slice's top and bottom edges come from stroking
              the band's own closed area path clipped to the run's x-range; its LEFT and RIGHT edges
              come from stroking a full-height rect clipped to the band. Neither alone is a closed
              shape — a clip cuts a stroke, it does not add one where the cut fell — so a single
              clipped path would draw a run with no ends, and a single rect would draw a box around
              the band rather than a slice of it.

              This is the one place the "🛑 never stroke `d`" rule in lib/charts/svg/paths.ts does not
              apply, and for the reason that rule gives: stroking `d` draws the baseline too. Here the
              baseline IS the slice's bottom edge, which is exactly what is wanted. */}
          {stacked &&
          props.variant === "stacked-areas" &&
          props.runBands?.length
            ? (() => {
                // `stacked` and `series` are index-aligned, so the band's own VALUES come along with
                // its path — `snapToBandEdges` needs them to find the foot of the band's ramp.
                const byKey = new Map(
                  stacked.map((b, i) => [
                    b.key,
                    { ...b, values: series[i].values },
                  ]),
                );
                const stripeId = `${clipPrefix}-stripe`;
                const stripeHoverId = `${clipPrefix}-stripe-hover`;
                return (
                  <g data-testid="run-bands">
                    {/* One pair of patterns for the whole chart, not one per run, so the texture is
                        continuous across every run drawn on it.

                        `patternUnits="userSpaceOnUse"` rather than the `objectBoundingBox` default:
                        the pitch has to be a fixed number of PIXELS. As a fraction of each run's own
                        box, a three-hour session and a ten-minute one would carry visibly different
                        textures. The tile is painted only where the rect is, so the other half is
                        fully transparent rather than a lighter wash. */}
                    <defs>
                      {[
                        [stripeId, RUN_FILL],
                        [stripeHoverId, RUN_FILL_HOVER],
                      ].map(([id, fill]) => (
                        <pattern
                          key={id}
                          id={id}
                          width={RUN_STRIPE_TILE}
                          height={RUN_STRIPE_TILE}
                          patternUnits="userSpaceOnUse"
                          patternTransform="rotate(45)"
                        >
                          <rect
                            width={RUN_STRIPE_WIDTH}
                            height={RUN_STRIPE_TILE}
                            fill={fill}
                          />
                        </pattern>
                      ))}
                    </defs>
                    {props.runBands.map((run, i) => {
                      const band = byKey.get(run.seriesId);
                      if (!band?.d) return null;
                      // Snap out to the foot of the band's own ramp so the outline traces the rise
                      // and fall rather than cutting across them — see `snapToBandEdges`.
                      const span = snapToBandEdges(
                        run.startMs,
                        run.endMs,
                        timestamps,
                        band.values,
                      );
                      const x0 = geo.x(new Date(span.startMs));
                      const x1 = geo.x(new Date(span.endMs));
                      // Sub-pixel runs are dropped rather than drawn: an invisible band that still
                      // answers the pointer reads as a phantom tooltip.
                      if (!(x1 - x0 >= 1)) return null;
                      const hovered = props.hoveredRunId === run.id;
                      // A run id is `<series>:<ISO start>`, so it carries `/`, `:` and `.` — all of
                      // which are legal in an XML id but ambiguous inside a `url(#…)` fragment.
                      // Index rather than sanitise: the ids are internal and need only be unique.
                      const rectId = `${clipPrefix}-rect-${i}`;
                      const bandId = `${clipPrefix}-band-${i}`;
                      return (
                        <g
                          key={run.id}
                          data-run={run.id}
                          style={{ cursor: "pointer" }}
                          onPointerEnter={() => {
                            // `x0`/`x1` are plot-relative (they come from the translated group), so
                            // adding the plot's own offset puts them in the chart's box — the box
                            // the panel is positioned inside. No measurement, nothing to go stale.
                            props.onHoverRun?.(run, {
                              x0: geo.plot.left + x0,
                              x1: geo.plot.left + x1,
                              plot: {
                                left: geo.plot.left,
                                top: geo.plot.top,
                                width: geo.plot.width,
                                height: geo.plot.height,
                              },
                            });
                          }}
                          onPointerLeave={() => props.onHoverRun?.(null)}
                        >
                          <defs>
                            <clipPath id={rectId}>
                              <rect
                                x={x0}
                                y={0}
                                width={x1 - x0}
                                height={geo.plot.height}
                              />
                            </clipPath>
                            <clipPath id={bandId}>
                              <path d={band.d} />
                            </clipPath>
                          </defs>
                          <path
                            d={band.d}
                            clipPath={`url(#${rectId})`}
                            fill={`url(#${hovered ? stripeHoverId : stripeId})`}
                            stroke="none"
                          />
                          <path
                            d={band.d}
                            clipPath={`url(#${rectId})`}
                            fill="none"
                            stroke={hovered ? RUN_EDGE_HOVER : RUN_EDGE}
                            strokeWidth={hovered ? 1.5 : 1}
                            pointerEvents="none"
                          />
                          <rect
                            x={x0}
                            y={0}
                            width={x1 - x0}
                            height={geo.plot.height}
                            clipPath={`url(#${bandId})`}
                            fill="none"
                            stroke={hovered ? RUN_EDGE_HOVER : RUN_EDGE}
                            strokeWidth={hovered ? 1.5 : 1}
                            pointerEvents="none"
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })()
            : null}

          {/* SoC on the right axis, dashed so it stays distinct from battery power, which shares its
              colour by design (Stage 3c). */}
          {(() => {
            if (!socLine) return null;
            const d = linePath(timestamps, socLine, geo.x, geo.y1!);
            return d ? (
              <path
                d={d}
                fill="none"
                stroke={CHART_COLORS.battery.soc}
                strokeWidth={CHART_INK.seriesStroke}
                strokeDasharray={SOC_DASH.join(" ")}
                data-series="soc"
              />
            ) : null;
          })()}

          <FocusLine
            at={hoveredTimestamp}
            x={geo.x}
            plotHeight={geo.plot.height}
          />
        </g>
      </svg>
    </div>
  );
}
