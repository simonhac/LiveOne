"use client";

/**
 * The axis furniture: gridlines, tick labels, shading bands and the focus line.
 *
 * Small and presentational on purpose. Each chart assembles its own `<svg>` and drops these in
 * (docs/plans/chart-library-consolidation.md, Stage 4 decision 3), so none of them owns layout or
 * data — they take a scale and some numbers and emit elements.
 *
 * All of them render inside the plot `<g>`, i.e. coordinates are relative to the plot area, not the
 * svg.
 */
import type { ScaleLinear, ScaleTime } from "d3-scale";
import { CHART_COLORS } from "@/lib/chart-colors";
import type { TimeTick } from "./time-ticks";

/** Matches the Chart.js styling these replace, so the port is not also a restyle. */
const GRID = "rgb(55, 65, 81)"; // gray-700
const TICK_TEXT = "rgb(156, 163, 175)"; // gray-400
const FONT_SIZE = 10;
const FONT_FAMILY = "DM Sans, system-ui, sans-serif";
const LINE_HEIGHT = 12;

export interface TimeAxisProps {
  ticks: TimeTick[];
  x: ScaleTime<number, number>;
  plotHeight: number;
  /**
   * Where the label sits relative to its gridline. D centres (a time reads as an instant); W and M
   * start-align, because a two-line date label belongs to the day that *begins* at that line.
   */
  align?: "center" | "start";
}

/**
 * Vertical gridlines plus tick labels below the plot.
 *
 * A tick with `label: null` still draws its gridline — that separation is why the old implementation
 * needed a zero-width space, and it is explicit here instead.
 */
export function TimeAxis({
  ticks,
  x,
  plotHeight,
  align = "center",
}: TimeAxisProps) {
  return (
    <g data-testid="time-axis">
      {ticks.map((t, i) => {
        const px = x(t.value);
        return (
          <g key={i} transform={`translate(${px}, 0)`}>
            <line y1={0} y2={plotHeight} stroke={GRID} strokeWidth={1} />
            {t.label && (
              <text
                y={plotHeight + 4}
                textAnchor={align === "center" ? "middle" : "start"}
                fill={TICK_TEXT}
                fontSize={FONT_SIZE}
                fontFamily={FONT_FAMILY}
                data-tick-label
              >
                {t.label.map((lineText, li) => (
                  <tspan key={li} x={0} dy={li === 0 ? FONT_SIZE : LINE_HEIGHT}>
                    {lineText}
                  </tspan>
                ))}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

export interface ValueAxisProps {
  scale: ScaleLinear<number, number>;
  plotWidth: number;
  side: "left" | "right";
  /** Appended to the TOPMOST tick only, matching the existing charts (`10 kW`, `100%`). */
  unit?: string;
  /** Hair-space before the unit — `40.0 °C` reads wrong tight, `100%` reads wrong spaced. */
  unitGap?: boolean;
  tickCount?: number;
  /** Left axes draw gridlines across the plot; a right axis would double them up. */
  gridlines?: boolean;
  /** Render ticks transparent — the load chart hides its right axis but keeps the layout. */
  hidden?: boolean;
}

/**
 * Horizontal gridlines plus value labels beside the plot.
 *
 * The unit sits on the top tick only. That is not decoration: repeating it on every tick is what the
 * charts deliberately avoid, and `number-typography.md` governs whether it is hair-spaced.
 */
export function ValueAxis({
  scale,
  plotWidth,
  side,
  unit,
  unitGap = true,
  tickCount = 6,
  gridlines = side === "left",
  hidden = false,
}: ValueAxisProps) {
  const ticks = scale.ticks(tickCount);
  const top = ticks[ticks.length - 1];

  return (
    <g data-testid={`value-axis-${side}`}>
      {ticks.map((v, i) => {
        const py = scale(v);
        const isTop = v === top;
        const text =
          isTop && unit ? `${v}${unitGap ? " " : ""}${unit}` : `${v}`;
        return (
          <g key={i} transform={`translate(0, ${py})`}>
            {gridlines && (
              <line x1={0} x2={plotWidth} stroke={GRID} strokeWidth={1} />
            )}
            <text
              x={side === "left" ? -6 : plotWidth + 6}
              dy="0.32em"
              textAnchor={side === "left" ? "end" : "start"}
              fill={hidden ? "transparent" : TICK_TEXT}
              fontSize={FONT_SIZE}
              fontFamily={FONT_FAMILY}
              data-tick-label
            >
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export interface ShadingBandsProps {
  bands: Array<{ start: number; end: number }>;
  x: ScaleTime<number, number>;
  plotHeight: number;
}

/** Daytime / weekday background columns. 7% white, as the annotation boxes were. */
export function ShadingBands({ bands, x, plotHeight }: ShadingBandsProps) {
  return (
    <g data-testid="shading-bands">
      {bands.map((b, i) => {
        const x0 = x(new Date(b.start));
        const x1 = x(new Date(b.end));
        return (
          <rect
            key={i}
            x={x0}
            y={0}
            width={Math.max(0, x1 - x0)}
            height={plotHeight}
            fill="rgba(255, 255, 255, 0.07)"
          />
        );
      })}
    </g>
  );
}

export interface FocusLineProps {
  at: Date | null;
  x: ScaleTime<number, number>;
  plotHeight: number;
}

/**
 * The shared crosshair at `ChartFocusContext`'s focused instant.
 *
 * Renders nothing when unfocused, rather than a hidden element — so "is anything focused?" is
 * answerable from the DOM.
 */
export function FocusLine({ at, x, plotHeight }: FocusLineProps) {
  if (!at) return null;
  return (
    <line
      data-testid="focus-line"
      x1={x(at)}
      x2={x(at)}
      y1={0}
      y2={plotHeight}
      stroke={CHART_COLORS.focusLine}
      strokeWidth={1}
    />
  );
}
