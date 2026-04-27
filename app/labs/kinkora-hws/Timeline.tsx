"use client";

import type { HwsModelStep } from "@/lib/hws-model";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const SLOT_MS = 5 * 60 * 1000;
const SLOTS_PER_DAY = 288;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function formatHHmm(tsMs: number, tzOffsetMin: number): string {
  const local = new Date(tsMs + tzOffsetMin * 60_000);
  const h = String(local.getUTCHours()).padStart(2, "0");
  const m = String(local.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatDayLabel(tsMs: number, tzOffsetMin: number): string {
  const local = new Date(tsMs + tzOffsetMin * 60_000);
  return `${WEEKDAYS[local.getUTCDay()]} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`;
}

function faucetColor(faucetC: number): string {
  const t = Math.max(0, Math.min(1, (faucetC - 30) / 10));
  const hue = 210 - 210 * t;
  return `hsl(${hue.toFixed(0)}, 80%, 50%)`;
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
  const stepByTs = new Map<number, HwsModelStep>();
  for (const s of steps) stepByTs.set(s.tsMs, s);

  const days: { dayStartMs: number; slots: (HwsModelStep | undefined)[] }[] =
    [];
  for (let d = 0; d < dayCount; d++) {
    const dayStartMs = firstDayMidnightMs + d * DAY_MS;
    const slots: (HwsModelStep | undefined)[] = new Array(SLOTS_PER_DAY);
    for (let i = 0; i < SLOTS_PER_DAY; i++) {
      slots[i] = stepByTs.get(dayStartMs + i * SLOT_MS);
    }
    days.push({ dayStartMs, slots });
  }
  days.reverse();

  const gridStyle = {
    gridTemplateColumns: `repeat(${SLOTS_PER_DAY}, minmax(0, 1fr))`,
  } as const;

  const hourTicks = Array.from({ length: 13 }, (_, i) => i * 2);

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={50}>
      <div className="-mx-6 px-3 py-3 sm:mx-0 sm:bg-gray-800 sm:rounded sm:p-4">
        <div className="flex items-end gap-3 mb-1">
          <div className="w-24 shrink-0" />
          <div className="flex-1 relative h-5 text-xs text-gray-400 select-none">
            {hourTicks.map((h) => {
              const left = (h / 24) * 100;
              const align =
                h === 0
                  ? "translate-x-0"
                  : h === 24
                    ? "-translate-x-full"
                    : "-translate-x-1/2";
              return (
                <div
                  key={h}
                  className={`absolute ${align}`}
                  style={{ left: `${left}%` }}
                >
                  {String(h).padStart(2, "0")}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          {days.map((day) => (
            <div key={day.dayStartMs} className="flex items-center gap-3">
              <div className="w-24 shrink-0 text-xs text-gray-300 text-right">
                {formatDayLabel(day.dayStartMs, tz)}
              </div>
              <div className="flex-1 relative">
                <div className="absolute inset-0 pointer-events-none">
                  {[25, 50, 75].map((pct) => (
                    <div
                      key={pct}
                      className="absolute top-0 bottom-0 w-px bg-gray-500"
                      style={{ left: `${pct}%` }}
                    />
                  ))}
                </div>
                <div
                  className="grid h-[11px] w-full relative"
                  style={gridStyle}
                >
                  {day.slots.map((s, i) => (
                    <Cell
                      key={i}
                      step={s}
                      tsMs={day.dayStartMs + i * SLOT_MS}
                      tz={tz}
                      background={powerBg(s)}
                    />
                  ))}
                </div>
                <div className="grid h-8 w-full relative" style={gridStyle}>
                  {day.slots.map((s, i) => (
                    <Cell
                      key={i}
                      step={s}
                      tsMs={day.dayStartMs + i * SLOT_MS}
                      tz={tz}
                      background={s ? faucetColor(s.faucetC) : "transparent"}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
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
    </TooltipProvider>
  );
}

function powerBg(s: HwsModelStep | undefined): string {
  if (!s) return "transparent";
  if (s.powerW === null) return "#374151";
  return s.on ? "rgb(251, 146, 60)" : "#6b7280";
}

function Cell({
  step,
  tsMs,
  tz,
  background,
}: {
  step: HwsModelStep | undefined;
  tsMs: number;
  tz: number;
  background: string;
}) {
  const cell = <div className="h-full w-full" style={{ background }} />;
  if (!step) return cell;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{cell}</TooltipTrigger>
      <TooltipContent>
        <div className="font-medium">
          {formatDayLabel(tsMs, tz)} {formatHHmm(tsMs, tz)}
        </div>
        <div>{step.faucetC.toFixed(1)} °C</div>
      </TooltipContent>
    </Tooltip>
  );
}
