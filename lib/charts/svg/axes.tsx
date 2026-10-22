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
import { CHART_INK } from "@/lib/charts/style";
import { classifyUnit } from "@/lib/point/unit-typography";
import type { TimeTick } from "./time-ticks";

/**
 * The ink these draw in. Values match the Chart.js styling they replaced, so the port was not also
 * a restyle; they now live in `lib/charts/style.ts` because the heatmap had grown a byte-identical
 * private copy of half of them.
 */
const {
  grid: GRID,
  tickText: TICK_TEXT,
  fontSize: FONT_SIZE,
  fontFamily: FONT_FAMILY,
  lineHeight: LINE_HEIGHT,
} = CHART_INK;

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
            fill={CHART_INK.shading}
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
  /**
   * Draw here instead of at `x(at)`. For BARS: `at` is the bucket's START, which on a bar is the
   * column's left edge, not the thing the reader is pointing at — the caller passes the category's
   * centre, read from the same numbers that placed the bar. `at` still decides *whether* to draw.
   */
  xPx?: number | null;
  /**
   * A bubble at the top of the line saying WHEN it points at (see `formatFocusLabel`). Needs
   * `plotWidth` to keep the bubble inside the plot at either edge; omitted ⇒ a bare line.
   */
  label?: string | null;
  plotWidth?: number;
}

/** The bubble's height, and how far it rises into the top margin (`DEFAULT_MARGIN.top` is 8). */
const BUBBLE_H = 16;
const BUBBLE_RISE = 6;
/** No DOM measuring for one short label: DM Sans at 10px averages ~5.6px a glyph. */
const BUBBLE_CHAR_PX = 5.6;
const BUBBLE_PAD_X = 6;

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
export function FocusLine({
  at,
  x,
  plotHeight,
  xPx,
  label,
  plotWidth,
}: FocusLineProps) {
  if (!at) return null;
  const px = xPx ?? x(at);
  const line = (
    <line
      data-testid="focus-line"
      x1={px}
      x2={px}
      y1={0}
      y2={plotHeight}
      stroke={CHART_COLORS.focusLine}
      strokeWidth={CHART_INK.focusStroke}
      pointerEvents="none"
    />
  );
  if (!label || plotWidth == null) return line;
  const w = Math.ceil(label.length * BUBBLE_CHAR_PX) + 2 * BUBBLE_PAD_X;
  // Centred on the line, but slid inward at the plot's edges rather than clipped: the line still
  // marks the exact instant, the bubble only has to be readable.
  const cx = Math.min(Math.max(px, w / 2), Math.max(w / 2, plotWidth - w / 2));
  return (
    <>
      {line}
      <g
        data-testid="focus-bubble"
        transform={`translate(${cx} ${-BUBBLE_RISE})`}
        pointerEvents="none"
      >
        <rect
          x={-w / 2}
          y={0}
          width={w}
          height={BUBBLE_H}
          rx={BUBBLE_H / 2}
          fill={CHART_COLORS.focusLine}
        />
        <text
          y={BUBBLE_H / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={CHART_INK.fontSize}
          fontFamily={CHART_INK.fontFamily}
          fontWeight={600}
        >
          {label}
        </text>
      </g>
    </>
  );
}
