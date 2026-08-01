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
import type { ChartTimeRange } from "@/lib/charts/scaffold";

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

  // --- DEFECT #6: the two charts' palettes, side by side ------------------------------------
  {
    id: "colours-lines-vs-stacked-load",
    kind: "colours",
    range: "D",
    mode: "load",
    focusAt: 0.62,
    note: "DEFECT #6: lines Battery=orange-400 (= stacked's Hot Water) and Grid=red-500 (≈ stacked's EV red-600)",
    width: W,
    height: 260,
  },
  {
    id: "colours-lines-vs-stacked-generation",
    kind: "colours",
    range: "D",
    mode: "generation",
    focusAt: 0.62,
    note: "DEFECT #6: lines Solar=yellow-400 vs stacked Solar=yellow-200; Grid red-500 vs pink-500",
    width: W,
    height: 260,
  },
];

export const CASE_IDS = CHART_CASES.map((c) => c.id);
