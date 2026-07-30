"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { scaleLinear, scaleTime } from "d3-scale";
import { timeHour } from "d3-time";
import { interpolateHsl } from "d3-interpolate";

/**
 * A day-per-row gradient stripe timeline for one point.
 *
 * Extracted verbatim (behaviour-wise) from the HWS lab timeline
 * (`app/labs/kinkora-hws/Timeline.tsx`) and generalised off `HwsModelStep`:
 *
 *  - `values` is the series being coloured (`intervalEndMs -> value`); the colour scale is built
 *    per-render from `domain` + `palette` rather than the lab's hardcoded 30–40 °C blue→red scale.
 *  - `state` is an OPTIONAL second series (e.g. the HWS element's power) painted as a thin on/off
 *    strip above each day. With no `state` the strip collapses (`POWER_H = 0`) and each day is a
 *    single full-height gradient row.
 *
 * A slot is "present" if EITHER map has a key for it; a present slot with a null/absent `state`
 * value paints the no-data grey, and a present slot with no `value` shows the background (no
 * carry-forward — callers that want one, like the lab, carry it forward when building `values`).
 *
 * Day bucketing assumes `slotMs` divides the tz offset (true for every real offset at 5m/30m).
 */

const DEFAULT_SLOT_MS = 5 * 60 * 1000;
const DEFAULT_SLOTS_PER_DAY = 288;
const DAY_MS = 24 * 60 * 60 * 1000;

const LABEL_W = 96;
const AXIS_H = 20;
const STATE_H = 11;
const VALUE_H = 32;
const DAY_GAP = 8;

const COLOR_STATE_ON = "rgb(251, 146, 60)";
const COLOR_STATE_OFF = "#6b7280";
const COLOR_NO_DATA = "#374151";
const COLOR_GRIDLINE = "#6b7280";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHHmm(tsMs: number, tz: number): string {
  const d = new Date(tsMs + tz * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDayLabel(tsMs: number, tz: number): string {
  const d = new Date(tsMs + tz * 60_000);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

interface Slot {
  /** The timestamp exists in `values` and/or `state` — i.e. the device reported something. */
  present: boolean;
  value: number | null;
  stateValue: number | null;
}

interface TooltipState {
  xPx: number;
  yPx: number;
  dayLabel: string;
  time: string;
  value: number | null;
}

export interface DailyStripesProps {
  /** intervalEndMs -> value, for the coloured row. */
  values: Map<number, number | null>;
  /** Optional intervalEndMs -> value for the thin on/off strip. Omit for a single-row-per-day view. */
  state?: Map<number, number | null>;
  /** Fixed local-time offset, in minutes. */
  tz: number;
  /** UTC ms of the first (oldest) local midnight to draw. */
  firstDayMidnightMs: number;
  dayCount: number;
  slotMs?: number;
  slotsPerDay?: number;
  /** Resolved colour domain — [min, max], clamped. */
  domain: [number, number];
  /** Resolved colour range — [from, to], interpolated in HSL. */
  palette: [string, string];
  /** `state` values strictly above this count as "on". */
  onThreshold?: number;
  unit?: string;
  label?: string;
}

export default function DailyStripes({
  values,
  state,
  tz,
  firstDayMidnightMs,
  dayCount,
  slotMs = DEFAULT_SLOT_MS,
  slotsPerDay = DEFAULT_SLOTS_PER_DAY,
  domain,
  palette,
  onThreshold = 0,
  unit,
  label,
}: DailyStripesProps) {
  const [containerRef, containerWidth] = useContainerWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const stateH = state ? STATE_H : 0;
  const dayH = stateH + VALUE_H;
  const unitSuffix = unit ? ` ${unit}` : "";

  const colorScale = useMemo(
    () =>
      scaleLinear<string>()
        .domain(domain)
        .range(palette)
        .interpolate(interpolateHsl)
        .clamp(true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domain[0], domain[1], palette[0], palette[1]],
  );

  const slotAt = useMemo(() => {
    return (tsMs: number): Slot => ({
      present: values.has(tsMs) || (state?.has(tsMs) ?? false),
      value: values.get(tsMs) ?? null,
      stateValue: state?.get(tsMs) ?? null,
    });
  }, [values, state]);

  const days = useMemo(() => {
    const arr: { dayStartMs: number; slots: Slot[] }[] = [];
    for (let d = 0; d < dayCount; d++) {
      const dayStartMs = firstDayMidnightMs + d * DAY_MS;
      const slots = new Array<Slot>(slotsPerDay);
      for (let i = 0; i < slotsPerDay; i++) {
        slots[i] = slotAt(dayStartMs + i * slotMs);
      }
      arr.push({ dayStartMs, slots });
    }
    arr.reverse();
    return arr;
  }, [firstDayMidnightMs, dayCount, slotsPerDay, slotMs, slotAt]);

  const chartW = Math.max(0, containerWidth - LABEL_W);
  const totalH = AXIS_H + dayCount * dayH + (dayCount - 1) * DAY_GAP;

  // x-scale on a normalised [0, DAY_MS] domain — every day shares the same scale,
  // and we look up tick offsets relative to the day start.
  const xScale = useMemo(
    () => scaleTime().domain([0, DAY_MS]).range([0, chartW]),
    [chartW],
  );

  const hourTicks = useMemo(
    () => xScale.ticks(timeHour.every(2) ?? timeHour),
    [xScale],
  );

  const gridlineXs = useMemo(
    () => [6, 12, 18].map((h) => xScale(h * 60 * 60 * 1000)),
    [xScale],
  );

  const ready = chartW > 0;

  function stateFill(s: Slot): string {
    if (!s.present) return "transparent";
    if (s.stateValue === null) return COLOR_NO_DATA;
    return s.stateValue > onThreshold ? COLOR_STATE_ON : COLOR_STATE_OFF;
  }

  function handleMove(
    e: React.MouseEvent<SVGRectElement>,
    day: { dayStartMs: number },
    rowYPx: number,
  ) {
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const xLocal = e.clientX - rect.left;
    if (xLocal < 0 || xLocal > chartW) return;
    const tInDay = xScale.invert(xLocal).valueOf();
    const slotIdx = Math.min(
      slotsPerDay - 1,
      Math.max(0, Math.floor(tInDay / slotMs)),
    );
    const tsMs = day.dayStartMs + slotIdx * slotMs;
    const slot = slotAt(tsMs);

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    setTooltip({
      xPx: e.clientX - containerRect.left,
      yPx: rowYPx,
      dayLabel: formatDayLabel(tsMs, tz),
      time: formatHHmm(tsMs, tz),
      value: slot.present ? slot.value : null,
    });
  }

  function handleLeave() {
    setTooltip(null);
  }

  return (
    <div className="-mx-6 px-3 py-3 sm:mx-0 sm:bg-gray-800 sm:rounded sm:p-4">
      <div ref={containerRef} className="relative">
        {ready && (
          <svg
            width={containerWidth}
            height={totalH}
            className="block"
            onMouseLeave={handleLeave}
          >
            {/* Top axis */}
            <g
              transform={`translate(${LABEL_W}, 0)`}
              className="text-xs"
              fill="#9ca3af"
            >
              {hourTicks.map((t) => {
                const ms = t.valueOf();
                const x = xScale(ms);
                const hour = ms / (60 * 60 * 1000);
                const anchor =
                  hour === 0 ? "start" : hour === 24 ? "end" : "middle";
                return (
                  <text
                    key={hour}
                    x={x}
                    y={14}
                    textAnchor={anchor}
                    className="select-none"
                  >
                    {String(hour).padStart(2, "0")}
                  </text>
                );
              })}
            </g>

            {/* Full-height gridlines, painted behind day rows */}
            <g transform={`translate(${LABEL_W}, ${AXIS_H})`}>
              {gridlineXs.map((gx, gi) => (
                <line
                  key={gi}
                  x1={gx}
                  x2={gx}
                  y1={0}
                  y2={dayCount * dayH + (dayCount - 1) * DAY_GAP}
                  stroke={COLOR_GRIDLINE}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
              ))}
            </g>

            {/* Day rows */}
            {days.map((day, i) => {
              const rowY = AXIS_H + i * (dayH + DAY_GAP);
              return (
                <g key={day.dayStartMs} transform={`translate(0, ${rowY})`}>
                  <text
                    x={LABEL_W - 12}
                    y={dayH / 2}
                    dy="0.35em"
                    textAnchor="end"
                    fill="#d1d5db"
                    className="text-xs select-none"
                  >
                    {formatDayLabel(day.dayStartMs, tz)}
                  </text>

                  <g transform={`translate(${LABEL_W}, 0)`}>
                    {/* State row */}
                    {state &&
                      day.slots.map((s, j) => {
                        const x0 = xScale(j * slotMs);
                        const x1 = xScale((j + 1) * slotMs);
                        return (
                          <rect
                            key={`p${j}`}
                            x={x0}
                            y={0}
                            width={x1 - x0}
                            height={stateH}
                            fill={stateFill(s)}
                            shapeRendering="crispEdges"
                          />
                        );
                      })}

                    {/* Value row */}
                    {day.slots.map((s, j) => {
                      if (!s.present || s.value === null) return null;
                      const x0 = xScale(j * slotMs);
                      const x1 = xScale((j + 1) * slotMs);
                      return (
                        <rect
                          key={`f${j}`}
                          x={x0}
                          y={stateH}
                          width={x1 - x0}
                          height={VALUE_H}
                          fill={colorScale(s.value)}
                          shapeRendering="crispEdges"
                        />
                      );
                    })}

                    {/* Hit overlay */}
                    <rect
                      x={0}
                      y={0}
                      width={chartW}
                      height={dayH}
                      fill="transparent"
                      onMouseMove={(e) => handleMove(e, day, rowY)}
                    />
                  </g>
                </g>
              );
            })}
          </svg>
        )}

        {tooltip && (
          <Tooltip
            xPx={tooltip.xPx}
            yPx={tooltip.yPx}
            dayLabel={tooltip.dayLabel}
            time={tooltip.time}
            value={tooltip.value}
            unitSuffix={unitSuffix}
            containerWidth={containerWidth}
          />
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400 pl-[108px]">
        <span>
          {[label, `${domain[0]}${unitSuffix}`].filter(Boolean).join(" ")}
        </span>
        <span
          className="inline-block h-3 w-24 rounded"
          style={{
            background: `linear-gradient(to right, ${palette[0]}, ${palette[1]})`,
          }}
        />
        <span>{`${domain[1]}${unitSuffix}`}</span>
      </div>
    </div>
  );
}

function Tooltip({
  xPx,
  yPx,
  dayLabel,
  time,
  value,
  unitSuffix,
  containerWidth,
}: {
  xPx: number;
  yPx: number;
  dayLabel: string;
  time: string;
  value: number | null;
  unitSuffix: string;
  containerWidth: number;
}) {
  const TOOLTIP_W = 130;
  const left = Math.max(
    0,
    Math.min(containerWidth - TOOLTIP_W, xPx - TOOLTIP_W / 2),
  );
  return (
    <div
      className="pointer-events-none absolute z-50 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100 shadow-md"
      style={{
        left,
        top: yPx - 4,
        width: TOOLTIP_W,
        transform: "translateY(-100%)",
      }}
    >
      <div className="font-medium">
        {dayLabel} {time}
      </div>
      <div>{value === null ? "—" : `${value.toFixed(1)}${unitSuffix}`}</div>
    </div>
  );
}
