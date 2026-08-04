/**
 * The chart-gallery case list — the single source of truth for what the screenshot harness covers.
 *
 * Imported by BOTH `ChartGallery.tsx` (to render) and `e2e/charts.spec.ts` (to enumerate), so a case
 * can never exist in one and not the other. Adding an entry here adds a baseline; `--update-snapshots`
 * then writes it.
 *
 * Case ids are used verbatim as snapshot filenames, so keep them kebab-case and stable — renaming one
 * orphans its baseline.
 */
import type { ChartTimeRange } from "@/lib/charts/temporal";

export type ChartCase = {
  id: string;
  /** What this case is *for* — shown in the gallery index, and the reason it earns a baseline. */
  note: string;
  /** Rendered chart box, in CSS px. Fixed so screenshots are size-stable. */
  width: number;
  height: number;
} & (
  | {
      kind: "lines";
      range: ChartTimeRange;
      noBattery?: boolean;
      noGrid?: boolean;
      withGap?: boolean;
      /** Fraction along the window to place the shared focus instant (crosshair). */
      focusAt?: number;
    }
  | {
      kind: "stacked";
      range: ChartTimeRange;
      mode: "load" | "generation";
      withGap?: boolean;
      focusAt?: number;
      /** Outline a run period (a charge session) on the EV band — `runBandsFixture`. */
      withRuns?: boolean;
      /** …and render it in its hovered state (deeper fill, brighter outline). */
      hoveredRun?: boolean;
    }
  | {
      /**
       * The heatmap fetches its own data, so these cases are fed by Playwright intercepting
       * `/api/history` (see `heatmapHistoryFixture`) rather than by props. `endDay` picks the local
       * date the window ends on, which is what decides whether any rows are off-frame.
       */
      kind: "heatmap";
      pointPath: string;
      pointUnit: string;
      metricType: string;
      palette: "viridis" | "plasma" | "turbo" | "rdylbu" | "greens";
      /** Local `YYYY-MM-DD` the 30-day window ends on. */
      endDay: string;
      timezone: string;
      dayOffsetMin: number;
      /** Narrow-band data around this value — for the fixed-domain SoC case. */
      narrowBandAround?: number;
    }
  | {
      kind: "ingestion";
      outage?: boolean;
      focusAt?: number;
    }
  | {
      /** The `lib/charts/svg` primitives rendering on their own — see PrimitivesDemo. */
      kind: "primitives";
      range: ChartTimeRange;
      withStack?: boolean;
      withGap?: boolean;
      focusAt?: number;
    }
  | {
      kind: "provenance";
      range: ChartTimeRange;
      dualAxis?: boolean;
      withProbe?: boolean;
      withBands?: boolean;
      withGap?: boolean;
      focusAt?: number;
    }
  | {
      /**
       * The stacked chart inside the DASHBOARD's own height chain — `flex-1` column → `h-full
       * min-h-[N]` → `relative flex-1 min-h-0` → the chart — with NO explicit height anywhere.
       *
       * Every other case hands its chart a fixed pixel box, which is precisely the hop this one
       * exists to cover: the chart measures its own root and draws nothing at zero height, so a
       * height that fails to resolve is a blank box, not a broken-looking chart. It renders as a
       * COLUMN under the mobile project's viewport (`md:` is a viewport query) and as a ROW under
       * desktop's, so the pair covers both branches of the dashboard's layout switch.
       *
       * `height` here is the chain's `min-height`, not a box — nothing in this case sets a height.
       */
      kind: "site-layout";
      range: ChartTimeRange;
      mode: "load" | "generation";
    }
  | {
      /**
       * Both charts stacked vertically over the SAME window — the arrangement the dashboard actually
       * uses. Exists to pin DEFECT #6: the lines chart paints Battery orange-400 and Grid red-500,
       * while the stacked chart paints Battery green-400 and Grid pink-500 (and orange-400 is Hot
       * Water, red-600 is EV). The clash is only visible when they are side by side.
       */
      kind: "colours";
      range: ChartTimeRange;
      mode: "load" | "generation";
      focusAt?: number;
    }
);

const W = 900;
const H = 340;

export const CHART_CASES: ChartCase[] = [
  // --- lines variant: the four periods (D/W power, M/Y energy→bars) -------------------------
  {
    id: "lines-d-power",
    kind: "lines",
    range: "D",
    note: "5m power lines; daytime shading bands; HH:mm ticks with every-other-label skipping",
    width: W,
    height: H,
  },
  {
    id: "lines-w-power",
    kind: "lines",
    range: "W",
    note: "30m power over 7d; two-line [weekday, date] ticks",
    width: W,
    height: H,
  },
  {
    id: "lines-m-energy",
    kind: "lines",
    range: "M",
    note: "daily energy BARS + SoC min/max band; weekday shading; 2/3/4-step tick skipping",
    width: W,
    height: H,
  },
  {
    id: "lines-y-energy",
    kind: "lines",
    range: "Y",
    note: "365d energy bars; month ticks with the year on January; no shading at year scale",
    width: W,
    height: H,
  },

  // --- lines variant: the shapes that expose the known legend defects -----------------------
  {
    id: "lines-d-no-battery",
    kind: "lines",
    range: "D",
    noBattery: true,
    note: "battery-less device: no Battery line AND no Battery legend entry (was defect #3 — a phantom all-nulls dataset)",
    width: W,
    height: H,
  },
  {
    id: "lines-d-no-grid",
    kind: "lines",
    range: "D",
    noGrid: true,
    note: "off-grid shape: grid is undefined, so the Grid dataset is correctly omitted",
    width: W,
    height: H,
  },
  {
    id: "lines-m-no-battery-bars",
    kind: "lines",
    range: "M",
    noBattery: true,
    note: "battery-less device, energy mode: real grouped bars keep their full width (was defect #3 — a phantom bar dataset narrowed and offset them)",
    width: W,
    height: H,
  },
  {
    id: "lines-d-gap",
    kind: "lines",
    range: "D",
    withGap: true,
    note: "null hole mid-window — gap rendering with nothing focused; legend lists every series that exists",
    width: W,
    height: H,
  },
  {
    id: "lines-d-focused",
    kind: "lines",
    range: "D",
    focusAt: 0.62,
    note: "crosshair + the legend WITH values; entries are identical to the unfocused case, only the numbers appear (was defect #1)",
    width: W,
    height: H,
  },
  {
    id: "lines-d-gap-focused",
    kind: "lines",
    range: "D",
    withGap: true,
    focusAt: 0.46,
    note: "focus inside the hole: every legend entry REMAINS, values simply blank (was defect #2 — Battery/Grid vanished mid-hover)",
    width: W,
    height: H,
  },
  {
    id: "lines-d-narrow",
    kind: "lines",
    range: "D",
    note: "phone-width plot: labels thin to fit. The mobile PROJECT renders the same 900px chart, so only an explicitly narrow case covers this",
    width: 340,
    height: H,
  },
  {
    id: "lines-m-narrow",
    kind: "lines",
    range: "M",
    note: "phone-width M: two-line [weekday, date] labels are the ones that collide, so this is the case measure-to-fit exists for",
    width: 340,
    height: H,
  },

  // --- stacked-areas variant ---------------------------------------------------------------
  {
    id: "stacked-load-d",
    kind: "stacked",
    range: "D",
    mode: "load",
    note: "stacked load areas (rest-of-house / HWS / EV / export) + SoC overlay on y1",
    width: W,
    height: H,
  },
  {
    id: "stacked-load-d-runs",
    kind: "stacked",
    range: "D",
    mode: "load",
    withRuns: true,
    note: "a run period marked on the EV band at rest — diagonal stripes plus an outline. The EV edges are TAPERED here (a real session's first and last intervals are partial averages): the outline must follow that taper all the way to the axis, which is what snapToBandEdges walks out to. Reaching the axis before the fill does is the bug it fixes",
    width: W,
    height: H,
  },
  {
    id: "stacked-load-d-runs-hovered",
    kind: "stacked",
    range: "D",
    mode: "load",
    withRuns: true,
    hoveredRun: true,
    note: "the same run hovered: deeper fill and a brighter outline. The at-rest and hovered pair is the only way a screenshot can show that hovering changes anything",
    width: W,
    height: H,
  },
  {
    id: "stacked-generation-d",
    kind: "stacked",
    range: "D",
    mode: "generation",
    note: "stacked generation areas; y1 SoC ticks visible (they are transparent in load mode)",
    width: W,
    height: H,
  },
  {
    id: "stacked-load-y-energy",
    kind: "stacked",
    range: "Y",
    mode: "load",
    note: "stacked BARS at year scale — the energy-mode branch of the stacked builder",
    width: W,
    height: H,
  },
  {
    id: "stacked-load-d-gap",
    kind: "stacked",
    range: "D",
    mode: "load",
    withGap: true,
    note: "the hard case for the port: Filler + stacking across nulls (d3 stack/area + .defined)",
    width: W,
    height: H,
  },
  {
    id: "stacked-load-d-focused",
    kind: "stacked",
    range: "D",
    mode: "load",
    focusAt: 0.62,
    note: "stacked crosshair at the shared focus instant",
    width: W,
    height: H,
  },

  // --- the dashboard's own height chain, unsized ---------------------------------------------
  {
    id: "site-layout-load-d",
    kind: "site-layout",
    range: "D",
    mode: "load",
    note: "the stacked chart sized only by the dashboard's flex chain, beside its legend. The mobile project renders the COLUMN branch, where a percentage height resolves to auto: that collapsed the chart to zero and drew nothing (fixed 2026-08-04). No fixed box — that is the point",
    width: W,
    height: 375,
  },

  // --- IngestionChart (/admin/observations), ported to SVG in Stage 5 -------------------------
  {
    id: "ingestion-24h",
    kind: "ingestion",
    note: "1,441 per-minute buckets as stacked step-after areas — two paths, not 2,882 sub-pixel bars",
    width: W,
    height: 360,
  },
  {
    id: "ingestion-outage",
    kind: "ingestion",
    outage: true,
    note: "an ingestion outage reads as a flat-zero stretch, which is what the chart exists to show",
    width: W,
    height: 360,
  },

  // --- lib/charts/svg primitives, rendering standalone ----------------------------------------
  {
    id: "primitives-d-lines",
    kind: "primitives",
    range: "D",
    focusAt: 0.62,
    note: "the SVG toolkit end to end: hourly gridlines with 2-hourly labels, daytime shading, both axes, dashed SoC on y1, focus line",
    width: W,
    height: H,
  },
  {
    id: "primitives-m-lines",
    kind: "primitives",
    range: "M",
    note: "M density: daily gridlines, two-line [weekday, date] labels every 4th day, weekday shading",
    width: W,
    height: H,
  },
  {
    id: "primitives-y-lines",
    kind: "primitives",
    range: "Y",
    note: "Y: monthly gridlines, year carried on January and the first tick, no shading",
    width: W,
    height: H,
  },
  {
    id: "primitives-d-stack-gap",
    kind: "primitives",
    range: "D",
    withStack: true,
    withGap: true,
    note: "stacked bands with a null hole — every band must BREAK through the column, not treat the null as zero",
    width: W,
    height: H,
  },

  // --- ProvenanceChart -----------------------------------------------------------------------
  {
    id: "provenance-y",
    kind: "provenance",
    range: "Y",
    note: "daily series at local noon over a year; stepped reserve floor; honest gaps (spanGaps: false)",
    width: W,
    height: 176,
  },
  {
    id: "provenance-m-dual-axis",
    kind: "provenance",
    range: "M",
    dualAxis: true,
    withProbe: true,
    note: "dual axes + a dashed probe overlay (ProvenanceChart styles dashed series at 1px, not 1.5px)",
    width: W,
    height: 176,
  },
  {
    id: "provenance-m-bands-focused",
    kind: "provenance",
    range: "M",
    withBands: true,
    focusAt: 0.62,
    note: "recal band annotations behind the series, with the crosshair drawn after them",
    width: W,
    height: 176,
  },
  {
    id: "provenance-m-gap",
    kind: "provenance",
    range: "M",
    withGap: true,
    note: "null hole — spanGaps is false here, so the line must BREAK rather than bridge",
    width: W,
    height: 176,
  },

  // --- HeatmapChart (fed by route-stubbed /api/history) ---------------------------------------
  {
    id: "heatmap-power-midwinter",
    kind: "heatmap",
    pointPath: "load/power",
    pointUnit: "W",
    metricType: "power",
    palette: "viridis",
    endDay: "2026-06-15",
    timezone: "Australia/Melbourne",
    dayOffsetMin: 600,
    note: "load power: the <=50 W black baseline, viridis ramp, no off-frame rows (whole window is AEST)",
    width: 900,
    height: 600,
  },
  {
    id: "heatmap-temperature-narrow-range",
    kind: "heatmap",
    pointPath: "load.hws/temperature",
    pointUnit: "\u00b0C",
    metricType: "temperature",
    palette: "turbo",
    endDay: "2026-06-15",
    timezone: "Australia/Melbourne",
    dayOffsetMin: 600,
    note: "non-power metric: no black baseline, and the full palette is used across the range (was defect #10/#11)",
    width: 900,
    height: 600,
  },
  {
    id: "heatmap-spanning-dst",
    kind: "heatmap",
    pointPath: "load/power",
    pointUnit: "W",
    metricType: "power",
    palette: "viridis",
    endDay: "2026-04-20",
    timezone: "Australia/Melbourne",
    dayOffsetMin: 600,
    note: "window spans the 5 Apr fall-back: rows before it are asterisked and the footnote appears",
    width: 900,
    height: 600,
  },
  {
    id: "heatmap-soc-fixed-domain",
    kind: "heatmap",
    pointPath: "bidi.battery/soc",
    pointUnit: "%",
    metricType: "soc",
    palette: "viridis",
    endDay: "2026-06-15",
    timezone: "Australia/Melbourne",
    dayOffsetMin: 600,
    narrowBandAround: 62,
    note: "SoC is pinned to 0-100 by definition: a battery idling at 60-65% reads as a narrow mid-palette band, not a full-palette sweep",
    width: 900,
    height: 600,
  },

  // --- DEFECT #6: the two charts' palettes, side by side ------------------------------------
  {
    id: "colours-lines-vs-stacked-load",
    kind: "colours",
    range: "D",
    mode: "load",
    focusAt: 0.62,
    note: "palette parity: both panels resolve through CHART_COLORS (was defect #6 — lines Battery was orange-400, byte-identical to the stacked chart's Hot Water, and Grid was red-500 beside its EV red-600)",
    width: W,
    height: 260,
  },
  {
    id: "colours-lines-vs-stacked-generation",
    kind: "colours",
    range: "D",
    mode: "generation",
    focusAt: 0.62,
    note: "palette parity, generation side: Solar is yellow-200 and Grid pink-500 in both (was defect #6 — yellow-400 vs yellow-200, red-500 vs pink-500)",
    width: W,
    height: 260,
  },
];

export const CASE_IDS = CHART_CASES.map((c) => c.id);
