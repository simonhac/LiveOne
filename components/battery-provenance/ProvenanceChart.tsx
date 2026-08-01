"use client";

import { useMemo } from "react";
import {
  FocusLine,
  TimeAxis,
  ValueAxis,
  buildGeometry,
  buildTimeTicks,
  linePath,
  useContainerSize,
  usePointerIndex,
} from "@/lib/charts/svg";
import type { ChartTimeRange } from "@/lib/charts/temporal";
import {
  RECAL_BAND_COLOR,
  type ProvenanceChartDef,
  type ProvenanceSeriesDef,
} from "@/lib/battery-provenance/field-registry";

/**
 * One chart of the battery-provenance history panel: a thin N-series line chart with a shared
 * crosshair and optional recalibration bands, styled entirely from the field registry.
 *
 * Ported off Chart.js in Stage 5 (docs/plans/chart-library-consolidation.md). Deliberately NOT a
 * `DashboardChart` variant — its two variants are hardwired to fixed-field chart data, while this
 * takes an arbitrary series list.
 *
 * The behaviours that survived the port, all of which the Chart.js version had to learn the hard way:
 *
 *  - **Honest gaps.** A null breaks the line rather than bridging it, and isolated days still show as
 *    points, so a single surviving day is visible rather than invisible.
 *  - **Stepped applied params.** A reserve floor holds for the whole day, so it steps rather than
 *    slopes — `stepAfter`, not interpolation.
 *  - **Hover is deduplicated and desktop-only on leave.** Both now live in `usePointerIndex`; the
 *    infinite-loop hazard the old implementation documented is described there.
 */

export interface ProvenanceBand {
  /** Epoch ms. */
  xMin: number;
  xMax: number;
  /**
   * Defaults to `RECAL_BAND_COLOR` — amber at 15 %, NOT the 7 % white the dashboard charts use for
   * daytime/weekday shading. These bands mean "the BMS recalibrated here", which is an event worth
   * noticing, not background texture.
   */
  fill?: string;
}

interface ProvenanceChartProps {
  def: ProvenanceChartDef;
  /** Local-noon Date per day, shared by every chart in the panel. */
  timestamps: Date[];
  /** Windowed values by series id, parallel to `timestamps`. */
  seriesValues: Record<string, (number | null)[]>;
  visibleSeries: Set<string>;
  /** Shared focus instant → the crosshair (same idiom as DashboardChart). */
  hoveredTimestamp: Date | null;
  onHoverIndexChange: (index: number | null) => void;
  timeRange: ChartTimeRange;
  windowStart: Date;
  windowEnd: Date;
  /** Recalibration bands, drawn behind the series. */
  bandAnnotations?: ProvenanceBand[];
  className?: string;
}

/** A series is "probe-like" — thinner — when the registry gave it a dash. */
const isProbeLike = (s: ProvenanceSeriesDef) => (s.dash?.length ?? 0) > 0;

export default function ProvenanceChart({
  def,
  timestamps,
  seriesValues,
  visibleSeries,
  hoveredTimestamp,
  onHoverIndexChange,
  timeRange,
  windowStart,
  windowEnd,
  bandAnnotations = [],
  className,
}: ProvenanceChartProps) {
  const [ref, size] = useContainerSize<HTMLDivElement>();
  const shown = def.series.filter((s) => visibleSeries.has(s.id));

  const geo = useMemo(() => {
    if (size.width === 0 || size.height === 0) return null;
    const axisDomain = (
      axis: { min?: number; max?: number; suggestedMin?: number; suggestedMax?: number },
      which: "y" | "y1",
    ): [number, number] => {
      // The registry's explicit min/max win; otherwise fall back to the data on that axis. These are
      // percentages, dollars and ratios with meaningful fixed ranges, so a registry bound is a
      // deliberate statement rather than a hint.
      const vals = shown
        .filter((s) => s.axis === which)
        .flatMap((s) => seriesValues[s.id] ?? [])
        .filter((v): v is number => v != null && Number.isFinite(v));
      const lo = axis.min ?? Math.min(axis.suggestedMin ?? 0, ...(vals.length ? vals : [0]));
      const hi = axis.max ?? Math.max(axis.suggestedMax ?? 0, ...(vals.length ? vals : [1]));
      return hi > lo ? [lo, hi] : [lo, lo + 1];
    };

    return buildGeometry({
      width: size.width,
      height: size.height,
      xDomain: [windowStart, windowEnd],
      yDomain: axisDomain(def.y, "y"),
      ...(def.y1 ? { y1Domain: axisDomain(def.y1, "y1") } : {}),
      margin: { top: 6, bottom: 30, left: 40, right: def.y1 ? 40 : 12 },
    });
  }, [size.width, size.height, windowStart, windowEnd, def, shown, seriesValues]);

  const pointer = usePointerIndex({
    timestamps,
    invert: (px) => (geo ? geo.x.invert(px) : new Date(0)),
    plotLeft: geo?.plot.left ?? 0,
    onChange: onHoverIndexChange,
  });

  return (
    <div className={className}>
      <div className="mb-1 text-xs text-gray-400">{def.title}</div>
      <div ref={ref} className="h-44">
        {geo && !geo.empty && (
          <svg
            width={size.width}
            height={size.height}
            data-testid="provenance-chart"
            onPointerMove={pointer.onPointerMove}
            onPointerLeave={pointer.onPointerLeave}
          >
            <g transform={`translate(${geo.plot.left}, ${geo.plot.top})`}>
              {/* Recal bands sit behind everything, as the annotation boxes did. */}
              {bandAnnotations.map((b, i) => {
                const x0 = geo.x(new Date(b.xMin));
                const x1 = geo.x(new Date(b.xMax));
                return (
                  <rect
                    key={i}
                    x={x0}
                    y={0}
                    width={Math.max(0, x1 - x0)}
                    height={geo.plot.height}
                    fill={b.fill ?? RECAL_BAND_COLOR}
                  />
                );
              })}

              <TimeAxis
                ticks={buildTimeTicks(timeRange, windowStart, windowEnd)}
                x={geo.x}
                plotHeight={geo.plot.height}
                align={timeRange === "D" ? "center" : "start"}
              />
              <ValueAxis
                scale={geo.y}
                plotWidth={geo.plot.width}
                side="left"
                unit={def.y.unit}
              />
              {geo.y1 && def.y1 && (
                <ValueAxis
                  scale={geo.y1}
                  plotWidth={geo.plot.width}
                  side="right"
                  unit={def.y1.unit}
                />
              )}

              {shown.map((s) => {
                const scale = s.axis === "y1" && geo.y1 ? geo.y1 : geo.y;
                const values = seriesValues[s.id] ?? [];
                const d = linePath(
                  timestamps,
                  values,
                  geo.x,
                  scale,
                  s.stepped ? "stepAfter" : "linear",
                );
                return (
                  <g key={s.id} data-series={s.id}>
                    {d && (
                      <path
                        d={d}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={isProbeLike(s) ? 1 : 1.5}
                        strokeDasharray={s.dash?.join(" ")}
                      />
                    )}
                    {/* Points keep an isolated day visible — a lone value has no line to draw. */}
                    {values.map((v, i) =>
                      v != null && Number.isFinite(v) ? (
                        <circle
                          key={i}
                          cx={geo.x(timestamps[i])}
                          cy={scale(v)}
                          r={1.5}
                          fill={s.color}
                        />
                      ) : null,
                    )}
                  </g>
                );
              })}

              <FocusLine
                at={hoveredTimestamp}
                x={geo.x}
                plotHeight={geo.plot.height}
              />
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

export type { ProvenanceChartProps };
