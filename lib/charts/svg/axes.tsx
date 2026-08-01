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
import { classifyUnit } from "@/lib/point/unit-typography";
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
  tickCount?: number;
  /** Left axes draw gridlines across the plot; a right axis would double them up. */
  gridlines?: boolean;
  /** Render ticks transparent — the load chart hides its right axis but keeps the layout. */
  hidden?: boolean;
}

/**
 * Horizontal gridlines plus value labels beside the plot.
 *
 * The unit sits on the top tick only — repeating it on every tick is what these charts deliberately
 * avoid.
 *
 * Spacing is decided by `classifyUnit`, not by the caller: `100%` and `40°C` are tight, `10 kW` is
 * hair-spaced (number-typography.md). A boolean prop here would be one more thing to get wrong per
 * call site, and the old Chart.js axis got it wrong exactly that way — its `axisTicks` helper emitted
 * `${value} ${unit}` unconditionally, so the provenance axes read `100 %` and `3.5 $`.
 *
 * The gap is a `<tspan dx>`, never a space character — the typography doc is explicit that a literal
 * space is full-width and renders differently across the two fonts in use.
 */
export function ValueAxis({
  scale,
  plotWidth,
  side,
  unit,
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
        const showUnit = isTop && !!unit;
        const gap = showUnit && classifyUnit(unit).headGap === "hair" ? 2 : 0;
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
              {v}
              {showUnit && <tspan dx={gap}>{unit}</tspan>}
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
 *
 * 🛑 `pointerEvents="none"` is load-bearing, not tidiness. This line FOLLOWS THE CURSOR and is drawn
 * last, so it is permanently the topmost element under the pointer. Anything below it that listens
 * for enter/leave therefore sees the pointer leave and re-enter on every single mouse move — which
 * made the run-period tooltip strobe while scrubbing across a charge session.
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
      pointerEvents="none"
    />
  );
}
