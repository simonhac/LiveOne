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
import type { ProvenanceChartDef } from "@/lib/battery-provenance/field-registry";

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
  windowEnd: Date;
} {
  const now = FIXED_NOW;
  const windowStart = new Date(now.getTime() - getPeriodDuration(range));
  const stepMs = getPeriodIntervalMinutes(range) * 60_000;
  const timestamps: Date[] = [];
  for (let t = windowStart.getTime(); t <= now.getTime(); t += stepMs) {
    timestamps.push(new Date(t));
  }
  return { timestamps, windowStart, windowEnd: now };
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
  windowEnd: Date;
};

/**
 * The `lines` variant's data, mirroring what `buildChartData` (`lib/charts/lines-data.ts`) produces.
 *
 * `noBattery` yields `batteryW: undefined`, symmetrical with `noGrid`/`grid`. It used to yield an
 * all-nulls ARRAY here, faithfully reproducing defect #3 — an array is truthy, so the dataset builder
 * added a phantom Battery series and the legend gate misfired. Fixed in Stage 3b; the fixture tracks
 * the fix because its job is to match the real builder, not to freeze the old bug.
 */
export function linesFixture(opts: LinesCaseOpts): LinesFixture {
  const { range, noBattery, noGrid, withGap } = opts;
  const { timestamps, windowStart, windowEnd } = buildTimestamps(range);
  const isEnergy = range === "M" || range === "Y";
  const rand = rng(0xc0ffee);

  // In energy (daily) mode the y values are kWh/day, so scale the per-interval shape up.
  const scale = isEnergy ? 24 * 0.6 : 1;
  const gapFrom = Math.floor(timestamps.length * 0.42);
  const gapTo = Math.floor(timestamps.length * 0.5);
  /**
   * A gapped sample is a REAL `null`, not `NaN`.
   *
   * This previously read `holed(...) ?? NaN`, written only to satisfy what `LineChartData` then
   * claimed (`number[]`) — and that silently defeated the whole point of the gap cases: `NaN !== null`,
   * so the old value-gated legend still rendered its Battery/Grid entries and defect #2 never
   * reproduced in the harness. The type has since been corrected to `(number | null)[]` (#18), which
   * is what `buildChartData` always actually emitted.
   */
  const holed = (v: number, i: number): number | null =>
    withGap && i >= gapFrom && i < gapTo ? null : round(v);

  const solar = timestamps.map((d, i) =>
    holed(solarShape(d) * 6.2 * (0.85 + rand() * 0.3) * scale, i),
  );
  const load = timestamps.map((d, i) =>
    holed(loadShape(d) * (0.9 + rand() * 0.2) * scale, i),
  );
  // Battery mops up the difference, clamped to a plausible inverter limit.
  const batteryW = timestamps.map((d, i) =>
    holed(
      Math.max(-5, Math.min(5, (solarShape(d) * 6.2 - loadShape(d)) * scale)),
      i,
    ),
  );
  const grid = timestamps.map((_, i) =>
    holed((load[i] ?? 0) - (solar[i] ?? 0) - (batteryW[i] ?? 0), i),
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
    // Faithful to buildChartData: absent battery ⇒ undefined, exactly like `grid` below.
    ...(noBattery ? {} : { batteryW }),
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

  return { chartData, paddedSOCData, windowStart, windowEnd };
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
  windowEnd: Date;
};

/** The `stacked-areas` variant's data: N stacked power series + a SoC overlay. */
export function stackedFixture(opts: StackedCaseOpts): StackedFixture {
  const { range, mode, withGap } = opts;
  const { timestamps, windowStart, windowEnd } = buildTimestamps(range);
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
    windowEnd,
  };
}

// ---------------------------------------------------------------------------------------------
// ProvenanceChart
// ---------------------------------------------------------------------------------------------

export type ProvenanceCaseOpts = {
  range: ChartTimeRange;
  /** Include the second (right-hand) axis and a series bound to it. */
  dualAxis?: boolean;
  /** Include a dashed "probe-like" overlay — the variant ProvenanceChart styles differently. */
  withProbe?: boolean;
  /** Include recalibration band annotations behind the series. */
  withBands?: boolean;
  withGap?: boolean;
};

export type ProvenanceFixture = {
  def: ProvenanceChartDef;
  timestamps: Date[];
  seriesValues: Record<string, (number | null)[]>;
  visibleSeries: Set<string>;
  bandAnnotations: object[];
  windowStart: Date;
  windowEnd: Date;
};

/**
 * A provenance panel chart: daily points at local noon, a stepped series, an optional dashed probe
 * overlay and an optional second axis.
 *
 * `def.series[].value` is never called here — `ProvenanceChart` reads from the `seriesValues` map the
 * panel hands it, and the registry's `value` accessors only run upstream. Supplying a throwing stub
 * would therefore hide a real regression if that ever changed, so these return null instead.
 */
export function provenanceFixture(opts: ProvenanceCaseOpts): ProvenanceFixture {
  const { range, dualAxis, withProbe, withBands, withGap } = opts;
  const { windowStart, windowEnd } = buildTimestamps(range);
  const rand = rng(0x9a1de5);

  // Daily points at local noon, exactly as BatteryProvenancePanel produces them.
  const dayCount =
    range === "Y" ? 365 : range === "M" ? 30 : range === "W" ? 7 : 1;
  const timestamps: Date[] = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(windowEnd.getTime() - i * 24 * 60 * 60 * 1000);
    d.setHours(12, 0, 0, 0);
    timestamps.push(d);
  }

  const gapFrom = Math.floor(timestamps.length * 0.4);
  const gapTo = Math.floor(timestamps.length * 0.48);
  const holed = (v: number, i: number): number | null =>
    withGap && i >= gapFrom && i < gapTo ? null : round(v, 2);

  const series: ProvenanceChartDef["series"] = [
    {
      id: "renewable",
      label: "Renewable",
      unit: "%",
      axis: "y",
      color: CHART_COLORS.solar.primary,
      decimals: 1,
      description: "Renewable share",
      value: () => null,
    },
    {
      id: "reserve",
      label: "Reserve floor",
      unit: "%",
      axis: "y",
      color: CHART_COLORS.battery.main,
      stepped: true, // applied params hold for the whole day
      decimals: 0,
      description: "Applied reserve floor",
      value: () => null,
    },
  ];
  if (withProbe) {
    series.push({
      id: "probe",
      label: "Forgone (probe)",
      unit: "%",
      axis: "y",
      color: CHART_COLORS.grid.main,
      dash: [4, 3],
      decimals: 1,
      description: "Probe overlay",
      value: () => null,
    });
  }
  if (dualAxis) {
    series.push({
      id: "cost",
      label: "Cost",
      unit: "$",
      axis: "y1",
      color: CHART_COLORS.ev,
      decimals: 2,
      description: "Daily cost",
      value: () => null,
    });
  }

  const seriesValues: Record<string, (number | null)[]> = {
    renewable: timestamps.map((_, i) =>
      holed(45 + 30 * Math.sin(i / 9) + rand() * 8, i),
    ),
    // Stepped: a handful of discrete levels, so the step-after rendering is actually visible.
    reserve: timestamps.map((_, i) => holed(20 + 10 * Math.floor(i / 7), i)),
    ...(withProbe
      ? {
          probe: timestamps.map((_, i) =>
            holed(30 + 20 * Math.cos(i / 11) + rand() * 5, i),
          ),
        }
      : {}),
    ...(dualAxis
      ? { cost: timestamps.map((_, i) => holed(2 + Math.sin(i / 5) * 1.5, i)) }
      : {}),
  };

  // Recal bands: xMin/xMax boxes behind the series, the shape ProvenanceChart appends before the
  // crosshair.
  const bandAnnotations: object[] = withBands
    ? [
        {
          type: "box",
          xMin: timestamps[Math.floor(dayCount * 0.2)]?.getTime(),
          xMax: timestamps[Math.floor(dayCount * 0.28)]?.getTime(),
          backgroundColor: "rgba(255, 255, 255, 0.07)",
          borderWidth: 0,
        },
        {
          type: "box",
          xMin: timestamps[Math.floor(dayCount * 0.66)]?.getTime(),
          xMax: timestamps[Math.floor(dayCount * 0.72)]?.getTime(),
          backgroundColor: "rgba(255, 255, 255, 0.07)",
          borderWidth: 0,
        },
      ]
    : [];

  const def: ProvenanceChartDef = {
    id: "fixture",
    title: "Renewable share and reserve floor",
    y: { unit: "%", min: 0, max: 100 },
    ...(dualAxis ? { y1: { unit: "$", suggestedMin: 0 } } : {}),
    series,
  };

  return {
    def,
    timestamps,
    seriesValues,
    visibleSeries: new Set(series.map((x) => x.id)),
    bandAnnotations,
    windowStart,
    windowEnd,
  };
}

// ---------------------------------------------------------------------------------------------
// HeatmapChart
// ---------------------------------------------------------------------------------------------

/**
 * A deterministic `/api/history` payload for the heatmap, in the shape the real endpoint returns.
 *
 * The heatmap fetches for itself rather than taking data as props, so — unlike every other case —
 * its baseline is produced by Playwright intercepting the request and fulfilling it with this. The
 * component's own request window still comes from the real clock, but nothing rendered depends on
 * it: the rows, the columns, the colour domain and the DST frame are all derived from the payload's
 * `firstInterval` and values, which are fixed here.
 *
 * `endDayIso` is the LOCAL date the window ends on, so a case can sit in midwinter (no off-frame
 * rows) or span a DST transition (some rows asterisked) on purpose.
 */
export function heatmapHistoryFixture(opts: {
  pointPath: string;
  seriesSuffix: string;
  units: string;
  endDayIso: string;
  days?: number;
  offsetMin?: number;
}): unknown {
  const {
    pointPath,
    seriesSuffix,
    units,
    endDayIso,
    days = 30,
    offsetMin = 600,
  } = opts;
  const SLOT = 30 * 60 * 1000;
  const rand = rng(0x4ea7);

  // Local midnight after `endDayIso`, expressed as a UTC instant.
  const endMs =
    Date.parse(`${endDayIso}T00:00:00Z`) + 86_400_000 - offsetMin * 60_000;
  const count = days * 48;
  const firstIntervalEndMs = endMs - (count - 1) * SLOT;

  const data: (number | null)[] = [];
  for (let i = 0; i < count; i++) {
    const slotOfDay = i % 48;
    const hour = slotOfDay / 2;
    // A daily arc with a mild day-to-day drift, plus deliberate holes so no-data cells are covered.
    const arc = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)) ** 1.3;
    const drift = 1 + 0.25 * Math.sin(i / (48 * 6));
    const missing = i % 811 === 0 || (i > count - 20 && i % 3 === 0);
    data.push(missing ? null : round(arc * 4200 * drift + rand() * 180, 1));
  }

  return {
    data: [
      {
        id: `device.1.${pointPath}.${seriesSuffix}`,
        path: `${pointPath}.${seriesSuffix}`,
        units,
        history: {
          firstInterval: new Date(firstIntervalEndMs).toISOString(),
          interval: "30m",
          data,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// IngestionChart (/admin/observations)
// ---------------------------------------------------------------------------------------------

/**
 * 24h of per-minute ingestion counts.
 *
 * The admin page fetches for itself, but the chart was extracted into a props-driven component by
 * the Stage 5 port — which is what makes a baseline possible at all. Shaped like the real thing:
 * a steady minutely poll, a 5-minute aggregation spike every fifth minute, and an outage stretch,
 * because "did ingestion stop?" is the question this chart exists to answer.
 */
export function ingestionFixture(opts: { outage?: boolean } = {}) {
  const MIN = 60_000;
  const end = Math.floor(FIXED_NOW.getTime() / MIN) * MIN;
  const start = end - 24 * 60 * MIN;
  const rand = rng(0x1e657);

  const timestamps: Date[] = [];
  const raw: number[] = [];
  const agg: number[] = [];
  let i = 0;
  for (let t = start; t <= end; t += MIN, i++) {
    timestamps.push(new Date(t));
    // A flat-zero stretch is how a real outage reads — deliberately not a gap.
    const down = opts.outage && i > 700 && i < 820;
    raw.push(down ? 0 : Math.round(34 + rand() * 8));
    agg.push(down ? 0 : i % 5 === 0 ? Math.round(28 + rand() * 6) : 0);
  }
  return { timestamps, raw, agg };
}
