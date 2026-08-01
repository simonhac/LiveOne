"use client";

/**
 * A reference chart built only from `lib/charts/svg` — the primitives' proof of life.
 *
 * It exists because a toolkit whose unit tests all pass can still render nothing, or render
 * nonsense: the tests assert numbers, and numbers are not pixels. This is also the worked example to
 * copy when porting a real chart, so it deliberately uses every piece — geometry, ticks, shading,
 * both axes, gap-aware lines, a stack, and the focus line — rather than the minimum that would draw.
 *
 * Not a product component. It lives in the gallery, under a baseline, and nothing else imports it.
 */
import {
  FocusLine,
  ShadingBands,
  TimeAxis,
  ValueAxis,
  buildGeometry,
  buildShadingBands,
  buildTimeTicks,
  linePath,
  niceDomain,
  stackedBands,
} from "@/lib/charts/svg";
import { CHART_COLORS } from "@/lib/chart-colors";
import type { ChartTimeRange } from "@/lib/charts/scaffold";

export interface PrimitivesDemoProps {
  range: ChartTimeRange;
  timestamps: Date[];
  /** Overlaid line series. */
  lines: Array<{
    key: string;
    colour: string;
    values: (number | null)[];
    dash?: number[];
  }>;
  /** Stacked band series, drawn behind the lines. */
  stack?: Array<{ key: string; colour: string; values: (number | null)[] }>;
  /** Right-hand axis series, 0–100 %. */
  soc?: (number | null)[];
  focus: Date | null;
  width: number;
  height: number;
}

export default function PrimitivesDemo({
  range,
  timestamps,
  lines,
  stack,
  soc,
  focus,
  width,
  height,
}: PrimitivesDemoProps) {
  const windowStart = timestamps[0];
  const windowEnd = timestamps[timestamps.length - 1];

  // The y domain must cover the stack TOTAL, not each band, or the tallest column clips.
  const stackTotals = stack
    ? timestamps.map((_, i) =>
        stack.reduce((sum, s) => {
          const v = s.values[i];
          return sum + (v != null && Number.isFinite(v) ? v : 0);
        }, 0),
      )
    : [];
  const yDomain = niceDomain([
    ...lines.flatMap((l) => l.values),
    ...stackTotals,
  ]);

  const geo = buildGeometry({
    width,
    height,
    xDomain: [windowStart, windowEnd],
    yDomain,
    ...(soc ? { y1Domain: [0, 100] as [number, number] } : {}),
  });
  if (geo.empty) return null;

  const ticks = buildTimeTicks(range, windowStart, windowEnd);
  const bands = buildShadingBands(range, windowStart, windowEnd);
  const stacked = stack
    ? stackedBands(
        timestamps,
        stack.map((s) => ({ key: s.key, values: s.values })),
        geo.x,
        geo.y,
      )
    : [];

  return (
    <svg width={width} height={height} data-testid="primitives-demo">
      <g transform={`translate(${geo.plot.left}, ${geo.plot.top})`}>
        <ShadingBands bands={bands} x={geo.x} plotHeight={geo.plot.height} />
        <TimeAxis
          ticks={ticks}
          x={geo.x}
          plotHeight={geo.plot.height}
          align={range === "D" ? "center" : "start"}
        />
        <ValueAxis
          scale={geo.y}
          plotWidth={geo.plot.width}
          side="left"
          unit="kW"
        />
        {geo.y1 && (
          <ValueAxis
            scale={geo.y1}
            plotWidth={geo.plot.width}
            side="right"
            unit="%"
          />
        )}

        {stacked.map((band, i) =>
          band.d ? (
            <path
              key={band.key}
              d={band.d}
              fill={stack![i].colour}
              fillOpacity={0.55}
              stroke="none"
            />
          ) : null,
        )}

        {lines.map((l) => {
          const d = linePath(timestamps, l.values, geo.x, geo.y);
          return d ? (
            <path
              key={l.key}
              d={d}
              fill="none"
              stroke={l.colour}
              strokeWidth={2}
              strokeDasharray={l.dash?.join(" ")}
              data-series={l.key}
            />
          ) : null;
        })}

        {soc && geo.y1
          ? (() => {
              const d = linePath(timestamps, soc, geo.x, geo.y1);
              return d ? (
                <path
                  d={d}
                  fill="none"
                  stroke={CHART_COLORS.battery.soc}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  data-series="soc"
                />
              ) : null;
            })()
          : null}

        <FocusLine at={focus} x={geo.x} plotHeight={geo.plot.height} />
      </g>
    </svg>
  );
}
