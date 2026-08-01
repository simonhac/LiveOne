"use client";

import { useMemo } from "react";
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
import { SOC_DASH, lineSeries } from "@/lib/charts/line-series";
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

  if (!geo || geo.empty) return <div ref={ref} className={className} />;

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
            : props.variant === "stacked-areas"
              ? stackedBands(timestamps, series, geo.x, geo.y).map((band, i) =>
                  band.d ? (
                    <path
                      key={band.key}
                      d={band.d}
                      fill={series[i].colour}
                      stroke={series[i].colour}
                      strokeWidth={2}
                      data-series={band.key}
                    />
                  ) : null,
                )
              : series.map((s) => {
                  const d = linePath(timestamps, s.values, geo.x, geo.y);
                  return d ? (
                    <path
                      key={s.key}
                      d={d}
                      fill="none"
                      stroke={s.colour}
                      strokeWidth={2}
                      data-series={s.key}
                    />
                  ) : null;
                })}

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
                strokeWidth={2}
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
