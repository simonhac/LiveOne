"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { scaleLinear, scaleTime } from "d3-scale";
import { timeHour } from "d3-time";
import { interpolateHsl } from "d3-interpolate";
import type { HwsModelStep } from "@/lib/hws-model";

const SLOT_MS = 5 * 60 * 1000;
const SLOTS_PER_DAY = 288;
const DAY_MS = 24 * 60 * 60 * 1000;

const LABEL_W = 96;
const AXIS_H = 20;
const POWER_H = 11;
const FAUCET_H = 32;
const DAY_H = POWER_H + FAUCET_H;
const DAY_GAP = 8;

const COLOR_POWER_ON = "rgb(251, 146, 60)";
const COLOR_POWER_OFF = "#6b7280";
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

const faucetScale = scaleLinear<string>()
  .domain([30, 40])
  .range(["hsl(210,80%,50%)", "hsl(0,80%,50%)"])
  .interpolate(interpolateHsl)
  .clamp(true);

function formatHHmm(tsMs: number, tz: number): string {
  const d = new Date(tsMs + tz * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDayLabel(tsMs: number, tz: number): string {
  const d = new Date(tsMs + tz * 60_000);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function powerFill(s: HwsModelStep | undefined): string {
  if (!s) return "transparent";
  if (s.powerW === null) return COLOR_NO_DATA;
  return s.on ? COLOR_POWER_ON : COLOR_POWER_OFF;
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

interface TooltipState {
  xPx: number;
  yPx: number;
  dayLabel: string;
  time: string;
  faucetC: number | null;
}

export default function Timeline({
  steps,
  tz,
  firstDayMidnightMs,
  dayCount,
}: {
  steps: HwsModelStep[];
  tz: number;
  firstDayMidnightMs: number;
  dayCount: number;
}) {
  const [containerRef, containerWidth] = useContainerWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const stepByTs = useMemo(() => {
    const m = new Map<number, HwsModelStep>();
    for (const s of steps) m.set(s.tsMs, s);
    return m;
  }, [steps]);

  const days = useMemo(() => {
    const arr: { dayStartMs: number; slots: (HwsModelStep | undefined)[] }[] =
      [];
    for (let d = 0; d < dayCount; d++) {
      const dayStartMs = firstDayMidnightMs + d * DAY_MS;
      const slots = new Array<HwsModelStep | undefined>(SLOTS_PER_DAY);
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        slots[i] = stepByTs.get(dayStartMs + i * SLOT_MS);
      }
      arr.push({ dayStartMs, slots });
    }
    arr.reverse();
    return arr;
  }, [firstDayMidnightMs, dayCount, stepByTs]);

  const chartW = Math.max(0, containerWidth - LABEL_W);
  const totalH = AXIS_H + dayCount * DAY_H + (dayCount - 1) * DAY_GAP;

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
      SLOTS_PER_DAY - 1,
      Math.max(0, Math.floor(tInDay / SLOT_MS)),
    );
    const slotMs = day.dayStartMs + slotIdx * SLOT_MS;
    const step = stepByTs.get(slotMs);

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    setTooltip({
      xPx: e.clientX - containerRect.left,
      yPx: rowYPx,
      dayLabel: formatDayLabel(slotMs, tz),
      time: formatHHmm(slotMs, tz),
      faucetC: step ? step.faucetC : null,
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
                  y2={dayCount * DAY_H + (dayCount - 1) * DAY_GAP}
                  stroke={COLOR_GRIDLINE}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
              ))}
            </g>

            {/* Day rows */}
            {days.map((day, i) => {
              const rowY = AXIS_H + i * (DAY_H + DAY_GAP);
              return (
                <g key={day.dayStartMs} transform={`translate(0, ${rowY})`}>
                  <text
                    x={LABEL_W - 12}
                    y={DAY_H / 2}
                    dy="0.35em"
                    textAnchor="end"
                    fill="#d1d5db"
                    className="text-xs select-none"
                  >
                    {formatDayLabel(day.dayStartMs, tz)}
                  </text>

                  <g transform={`translate(${LABEL_W}, 0)`}>
                    {/* Power row */}
                    {day.slots.map((s, j) => {
                      const x0 = xScale(j * SLOT_MS);
                      const x1 = xScale((j + 1) * SLOT_MS);
                      return (
                        <rect
                          key={`p${j}`}
                          x={x0}
                          y={0}
                          width={x1 - x0}
                          height={POWER_H}
                          fill={powerFill(s)}
                          shapeRendering="crispEdges"
                        />
                      );
                    })}

                    {/* Faucet row */}
                    {day.slots.map((s, j) => {
                      if (!s) return null;
                      const x0 = xScale(j * SLOT_MS);
                      const x1 = xScale((j + 1) * SLOT_MS);
                      return (
                        <rect
                          key={`f${j}`}
                          x={x0}
                          y={POWER_H}
                          width={x1 - x0}
                          height={FAUCET_H}
                          fill={faucetScale(s.faucetC)}
                          shapeRendering="crispEdges"
                        />
                      );
                    })}

                    {/* Hit overlay */}
                    <rect
                      x={0}
                      y={0}
                      width={chartW}
                      height={DAY_H}
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
            faucetC={tooltip.faucetC}
            containerWidth={containerWidth}
          />
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400 pl-[108px]">
        <span>Faucet 30 °C</span>
        <span
          className="inline-block h-3 w-24 rounded"
          style={{
            background:
              "linear-gradient(to right, hsl(210,80%,50%), hsl(0,80%,50%))",
          }}
        />
        <span>40 °C</span>
      </div>
    </div>
  );
}

function Tooltip({
  xPx,
  yPx,
  dayLabel,
  time,
  faucetC,
  containerWidth,
}: {
  xPx: number;
  yPx: number;
  dayLabel: string;
  time: string;
  faucetC: number | null;
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
      <div>{faucetC === null ? "—" : `${faucetC.toFixed(1)} °C`}</div>
    </div>
  );
}
