/**
 * Deterministic fixture data for the chart gallery (app/labs/chart-gallery).
 *
 * These back the Playwright screenshot baselines, so **every value here must be a pure function of
 * the case name** — no `Date.now()`, no `Math.random()`, no module-import timestamps. (Contrast
 * `../card-gallery/fixtures.ts`, which deliberately stamps ages at import: fine for eyeballing, fatal
 * for a checked-in baseline.)
 *
 * The reference instant is fixed and the harness pins the browser timezone to match
 * (`playwright.config.ts` → `timezoneId`), because the charts format ticks with date-fns `format`,
 * which renders in the *browser's* local zone.
 */
import type {
  ChartData,
  LineChartData,
  PaddedSOCData,
  SeriesData,
} from "@/lib/charts/types";
import type { ChartTimeRange } from "@/lib/charts/scaffold";
import {
  getPeriodDuration,
  getPeriodIntervalMinutes,
} from "@/lib/charts/temporal";
import { CHART_COLORS } from "@/lib/chart-colors";

/**
 * The frozen "now" every case is rendered against: 2026-06-15 14:30 AEST (a Monday afternoon, mid
 * winter). Chosen so the D window straddles a midnight, the W/M windows contain both weekend and
 * weekday shading bands, and the solar curve is a short winter day rather than a flat-topped one.
 */
export const FIXED_NOW = new Date("2026-06-15T14:30:00+10:00");

/** Deterministic [0,1) noise — a plain LCG, so a case always renders identically. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Evenly-spaced timestamps across the period, at the period's real data interval. */
function buildTimestamps(range: ChartTimeRange): {
  timestamps: Date[];
  windowStart: Date;
  now: Date;
} {
  const now = FIXED_NOW;
  const windowStart = new Date(now.getTime() - getPeriodDuration(range));
  const stepMs = getPeriodIntervalMinutes(range) * 60_000;
  const timestamps: Date[] = [];
  for (let t = windowStart.getTime(); t <= now.getTime(); t += stepMs) {
    timestamps.push(new Date(t));
  }
  return { timestamps, windowStart, now };
}

/** Fraction of a solar day at `d`, 0 outside ~07:00–17:00 local (a winter arc). */
function solarShape(d: Date): number {
  const hour = d.getHours() + d.getMinutes() / 60;
  const SUNRISE = 7.2;
  const SUNSET = 17.1;
  if (hour <= SUNRISE || hour >= SUNSET) return 0;
  return Math.sin(((hour - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI) ** 1.4;
}

/** A domestic load shape: overnight base, a morning bump, an evening peak. */
function loadShape(d: Date): number {
  const hour = d.getHours() + d.getMinutes() / 60;
  const morning = Math.exp(-(((hour - 7.5) / 1.3) ** 2)) * 1.9;
  const evening = Math.exp(-(((hour - 18.5) / 1.8) ** 2)) * 3.1;
  return 0.45 + morning + evening;
}

export type LinesCaseOpts = {
  range: ChartTimeRange;
  /** Omit the battery series entirely — the "battery-less device" shape. */
  noBattery?: boolean;
  /** Omit the grid series entirely — the "off-grid device" shape. */
  noGrid?: boolean;
  /** Punch a null hole mid-window, to exercise gap rendering + the legend flicker defect. */
  withGap?: boolean;
};

export type LinesFixture = {
  chartData: LineChartData;
  paddedSOCData: PaddedSOCData | null;
  windowStart: Date;
  now: Date;
};

/**
 * The `lines` variant's data. Note `batteryW` is populated as an all-nulls array when `noBattery` is
 * set, faithfully reproducing what `buildChartData` does today (`lib/charts/lines-data.ts:150-154`)
 * — that asymmetry with `grid` (which becomes `undefined`) IS defect #3 in the plan, and this
 * fixture exists so the fix shows up as a visible baseline diff.
 */
export function linesFixture(opts: LinesCaseOpts): LinesFixture {
  const { range, noBattery, noGrid, withGap } = opts;
  const { timestamps, windowStart, now } = buildTimestamps(range);
  const isEnergy = range === "M" || range === "Y";
  const rand = rng(0xc0ffee);

  // In energy (daily) mode the y values are kWh/day, so scale the per-interval shape up.
  const scale = isEnergy ? 24 * 0.6 : 1;
  const gapFrom = Math.floor(timestamps.length * 0.42);
  const gapTo = Math.floor(timestamps.length * 0.5);
  const holed = <T>(v: T, i: number): T | null =>
    withGap && i >= gapFrom && i < gapTo ? null : v;

  const solar = timestamps.map((d, i) =>
    round(holed(solarShape(d) * 6.2 * (0.85 + rand() * 0.3) * scale, i) ?? NaN),
  );
  const load = timestamps.map((d, i) =>
    round(holed(loadShape(d) * (0.9 + rand() * 0.2) * scale, i) ?? NaN),
  );
  // Battery mops up the difference, clamped to a plausible inverter limit.
  const batteryW = timestamps.map((d, i) =>
    round(
      holed(
        Math.max(-5, Math.min(5, (solarShape(d) * 6.2 - loadShape(d)) * scale)),
        i,
      ) ?? NaN,
    ),
  );
  const grid = timestamps.map((_, i) =>
    round(
      holed((load[i] ?? 0) - (solar[i] ?? 0) - (batteryW[i] ?? 0), i) ?? NaN,
    ),
  );

  // SoC integrates the battery flow, clamped 20–100 %.
  let soc = 62;
  const batterySOC = timestamps.map((_, i) => {
    soc = Math.max(20, Math.min(100, soc + (batteryW[i] ?? 0) * 0.55));
    return round(soc, 1);
  });

  const chartData: LineChartData = {
    timestamps,
    solar,
    load,
    // Faithful to buildChartData: absent battery ⇒ all-nulls array, NOT undefined.
    batteryW: noBattery
      ? (timestamps.map(() => null) as unknown as number[])
      : batteryW,
    batterySOC,
    ...(noGrid ? {} : { grid }),
    mode: isEnergy ? "energy" : "power",
  };

  // The SoC min/max band only exists in energy (daily) mode.
  const paddedSOCData: PaddedSOCData | null = isEnergy
    ? {
        timestamps,
        min: batterySOC.map((v) => round(Math.max(20, v - 11), 1)),
        max: batterySOC.map((v) => round(Math.min(100, v + 9), 1)),
      }
    : null;

  return { chartData, paddedSOCData, windowStart, now };
}

export type StackedCaseOpts = {
  range: ChartTimeRange;
  mode: "load" | "generation";
  withGap?: boolean;
};

export type StackedFixture = {
  chartData: ChartData;
  visibleSeries: Set<string>;
  windowStart: Date;
  now: Date;
};

/** The `stacked-areas` variant's data: N stacked power series + a SoC overlay. */
export function stackedFixture(opts: StackedCaseOpts): StackedFixture {
  const { range, mode, withGap } = opts;
  const { timestamps, windowStart, now } = buildTimestamps(range);
  const isEnergy = range === "M" || range === "Y";
  const scale = isEnergy ? 24 * 0.6 : 1;
  const rand = rng(mode === "load" ? 0x5eed01 : 0x5eed02);

  const gapFrom = Math.floor(timestamps.length * 0.42);
  const gapTo = Math.floor(timestamps.length * 0.5);
  const hole = (i: number) => withGap && i >= gapFrom && i < gapTo;

  const build = (
    id: string,
    description: string,
    color: string,
    shape: (d: Date, i: number) => number,
  ): SeriesData => ({
    id,
    description,
    color,
    seriesType: "power",
    data: timestamps.map((d, i) =>
      hole(i) ? null : round(shape(d, i) * scale),
    ),
  });

  const series: SeriesData[] =
    mode === "generation"
      ? [
          build(
            "source.solar",
            "Solar",
            CHART_COLORS.solar.primary,
            (d) => solarShape(d) * 5.1 * (0.88 + rand() * 0.24),
          ),
          build(
            "source.solar.remote",
            "Solar (shed)",
            CHART_COLORS.solar.secondary,
            (d) => solarShape(d) * 1.4 * (0.85 + rand() * 0.3),
          ),
          build("bidi.battery.out", "Battery", CHART_COLORS.battery.main, (d) =>
            Math.max(0, loadShape(d) - solarShape(d) * 6.5),
          ),
          build("bidi.grid.in", "Grid", CHART_COLORS.grid.main, (d) =>
            Math.max(0, loadShape(d) * 0.35 - solarShape(d) * 2.2),
          ),
        ]
      : [
          build(
            "load.rest-of-house",
            "Rest of house",
            CHART_COLORS.restOfHouse,
            (d) => Math.max(0.2, loadShape(d) * 0.55),
          ),
          build("load.hws", "Hot water", CHART_COLORS.hotWater, (d) =>
            d.getHours() >= 1 && d.getHours() < 4 ? 3.4 : 0,
          ),
          build("load.ev", "EV", CHART_COLORS.ev, (d) =>
            d.getHours() >= 22 || d.getHours() < 2 ? 7.2 : 0,
          ),
          build("bidi.grid.out", "Export", CHART_COLORS.grid.main, (d) =>
            Math.max(0, solarShape(d) * 4.4 - loadShape(d)),
          ),
        ];

  let soc = 55;
  series.push({
    id: "bidi.battery/soc",
    description: "Battery SoC",
    color: CHART_COLORS.battery.soc,
    seriesType: "soc",
    data: timestamps.map((d, i) => {
      if (hole(i)) return null;
      soc = Math.max(
        18,
        Math.min(100, soc + (solarShape(d) * 6 - loadShape(d)) * 0.5),
      );
      return round(soc, 1);
    }),
  });

  return {
    chartData: { timestamps, series, mode: isEnergy ? "energy" : "power" },
    visibleSeries: new Set(series.map((s) => s.id)),
    windowStart,
    now,
  };
}
