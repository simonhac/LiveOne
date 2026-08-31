/**
 * The chart style tokens — surface, ink and legend.
 *
 * Source of truth for the *what*; `docs/architecture/chart-style.md` holds the *why*. Same split as
 * `lib/point/unit-typography.ts` / `docs/architecture/number-typography.md`, and for the same reason:
 * a rule that lives only in prose gets re-typed slightly differently at every call site.
 *
 * Deliberately a plain `.ts` module with no `"use client"` and no React import — a class string is
 * not a component, and a server component that lays out a panel should be able to read these too.
 *
 * 🛑 Colours are NOT here. The series palette is `lib/chart-colors.ts` (`CHART_COLORS`), which is
 * about *identity* — which hue means Solar — and is guarded by its own tests. This module is about
 * *furniture*: the box around the plot, the grey the gridlines are drawn in, the shape of a legend
 * swatch. The one place they meet is `legendSwatchStyle`, which takes a palette colour as an
 * argument rather than knowing any.
 */

// ---------------------------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------------------------

/**
 * The one framed surface: a v4 section, or a panel rendered standalone on its own page.
 *
 * ONE FRAME PER NESTING LEVEL. A card body inside a section adds nothing — no background, no
 * border, no radius. Nesting a filled card inside the section's own box is what made the lines
 * chart and the stacked chart look like different products (they are the same component).
 *
 * Never breakpoint-gate this. The lines chart carried `md:bg-gray-800 md:border md:rounded` and the
 * daily-stripe card `sm:bg-gray-800 sm:rounded`, so both grew a frame at a width the charts beside
 * them did not — the drift was invisible on a phone and glaring on a laptop.
 */
export const CHART_PANEL =
  "rounded-lg border border-gray-700/70 bg-gray-900/30";

/** Padding inside {@link CHART_PANEL}. */
export const CHART_PANEL_PAD = "p-2 sm:p-3";

/**
 * Padding for a card body inside a panel. The body's only contribution to the surface — it holds
 * the chart off the section's edge and off its neighbours.
 */
export const CHART_BODY_PAD = "p-2 sm:p-4";

/**
 * A hairline around content that has no shape of its own — no fill.
 *
 * A chart delimits itself: axes down the left, gridlines across, tick labels below. A TABLE does
 * not, and a scroll region needs an edge to scroll within. So a tabular card may draw this around
 * the table, and only around the table — never a filled card around the whole card.
 */
export const CHART_HAIRLINE = "rounded-lg border border-gray-700/70";

// ---------------------------------------------------------------------------------------------
// Ink — SVG attribute values, not classes
// ---------------------------------------------------------------------------------------------

/**
 * Everything drawn into an `<svg>` that is not a series.
 *
 * These were module-private constants in `lib/charts/svg/axes.tsx` with a byte-identical second
 * copy in `components/HeatmapChart.tsx` (`TICK_TEXT`, `FONT_FAMILY`, and two bare `fontSize={10}`).
 * Two copies of one number is one copy too many for a value whose whole job is to be the same
 * everywhere.
 *
 * `fontFamily` is spelled out rather than inherited from the `<body>`: an `<svg>` text node does
 * inherit CSS `font-family`, but these charts are also rendered into fixed-size Playwright
 * baselines, and an inherited font is one more thing that can differ between the app and the
 * gallery.
 */
export const CHART_INK = {
  /** Gridlines, both axes. gray-700. */
  grid: "rgb(55, 65, 81)",
  /** Tick labels, both axes. gray-400. */
  tickText: "rgb(156, 163, 175)",
  /** Tick label size, px. */
  fontSize: 10,
  fontFamily: "DM Sans, system-ui, sans-serif",
  /** Baseline-to-baseline for a two-line tick label (W and M stack `[weekday, date]`). */
  lineHeight: 12,
  /** A line series. The stroke IS the data here, so it carries weight. */
  seriesStroke: 2,
  /**
   * The top edge of a filled stacked band — a hairline, deliberately thinner than `seriesStroke`.
   * On a filled band the stroke is only a boundary; at 2px it dominates a narrow chart, and a
   * series resting at zero reads as a heavy rule along the axis rather than a quiet edge.
   */
  bandEdgeStroke: 1,
  /** The shared crosshair. */
  focusStroke: 1,
  /** Daytime / weekday background columns. */
  shading: "rgba(255, 255, 255, 0.07)",
} as const;

// ---------------------------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------------------------

/**
 * One legend vocabulary, two legend forms.
 *
 * The lines chart labels its series in a row under the plot (`components/ChartTooltip.tsx`); the
 * stacked chart uses a table beside it (`components/EnergyTable.tsx`). Both are legitimate — a row
 * suits five fixed series, a table suits a variable set you can toggle and total. PLACEMENT stays
 * different; INK does not. The swatch, the label colour, the value colour and the numeral font are
 * these tokens in both.
 *
 * The direction of travel was stacked → lines: the table was already the more careful of the two
 * (the row had four copy-pasted inline `style` blocks pinning a 48px min-width and re-declaring
 * DM Sans).
 */
export const LEGEND_ROW = "flex items-center text-xs";

/**
 * The swatch box, without its border — for a swatch that draws its own mark inside (the dashed
 * Battery-SoC rule). A `border-2` frame around a 2px dash would read as a filled square.
 *
 * 🛑 Separate constant rather than `${LEGEND_SWATCH} border-0`: `border-0` and `border-2` are the
 * same Tailwind property, so which one wins is decided by stylesheet order, not by which appears
 * later in the `class` attribute.
 */
export const LEGEND_SWATCH_BOX = "w-3 h-3 rounded-sm flex-shrink-0";

/**
 * The swatch box. Filled *and* bordered in the series colour, so a legend entry can also express
 * "hidden" — see {@link legendSwatchStyle}.
 */
export const LEGEND_SWATCH = `${LEGEND_SWATCH_BOX} border-2`;

/** A series name. */
export const LEGEND_LABEL = "text-gray-300";

/** A column heading in a table legend ("Load", "Energy (kWh)", "%"). */
export const LEGEND_HEADER = "text-gray-400";

/**
 * A legend's numbers.
 *
 * `font-mono` and `tabular-nums` together, not either alone: the mono face is what makes a column
 * of readings scan as a column, and `tabular-nums` is what stops a live value shoving its unit
 * sideways on every poll (see docs/architecture/number-typography.md). Callers add their own width.
 */
export const LEGEND_VALUE = "text-gray-100 font-mono tabular-nums text-right";

/**
 * The inline half of a legend swatch — the part that has to name an actual colour.
 *
 * A hidden series keeps its outline and loses its fill, so the row still says which colour it *is*
 * while saying it is off. That is the stacked table's existing toggle idiom, lifted here so the two
 * legends draw the same square.
 */
export function legendSwatchStyle(
  color: string,
  visible = true,
): { backgroundColor: string; borderColor: string } {
  return {
    backgroundColor: visible ? color : "transparent",
    borderColor: color,
  };
}
