/**
 * THE measured card footprints — every number `CardPlugin.footprint` returns, in one auditable
 * table rather than scattered as literals across eleven plugin modules.
 *
 * WHY THESE EXIST. A dashboard's cards each own their own query (history, sankey, amber, latest
 * readings, run periods, provenance, heatmap points), and none of those are SSR-prefetched — only
 * `/api/data` is (app/dashboard/[...slug]/page.tsx). So every card is a placeholder for a moment,
 * and if the placeholder is not the size of the card, the page relayouts underneath the reader. The
 * old vocabulary was two constants — a 120px tile box and a 360px "chart" box — standing in for
 * twenty card types, which is how a 764px sankey block came to pop in out of nothing.
 *
 * 🛑 MEASURED, NOT GUESSED. The `measured` values below were read off the settled cards in
 * production at a 1960px viewport (1247px section container) on 2026-08-01 — see
 * docs/performance/dashboard-layout-stability.md for the recipe and the raw numbers. When a card's
 * layout changes, RE-MEASURE; do not nudge. The `estimated` values are for card types that are not
 * placed on any dashboard yet, so there was nothing settled to measure — they are derived from the
 * component's own box model and are corrected in practice by `<CardSlot>`'s remembered heights.
 *
 * A footprint is a FLOOR, not a promise. Cards whose height follows their row count
 * (device-metrics, amber-timeline, generator-runs) can only be approximated statically; the value
 * here is the typical case, and the true one is learned per node on first render.
 */

/** Site-charts collapse: one stacked chart + its side table, including the block's own padding. */
const STACKED_CHART_ROW = 403; // measured: Kinkora load+generation block = 806 / 2

/** Site-charts collapse: the "Flows" header + the 680px sankey SVG + its period label + padding. */
const SANKEY_BLOCK = 764; // measured: Daylesford (sankey with no stacked charts) = 764

export const CARD_FOOTPRINTS = {
  /** measured — `LinesChartCard` is `h-full min-h-[360px]` and settles exactly there. */
  chart: 360,
  /** measured — Daylesford: the header plus the "no generator runs in this period" line. A
   *  populated table grows to `max-h-[420px]`, but the empty/short case is the honest default:
   *  over-reserving leaves visible dead space on EVERY load, where under-reserving costs one load's
   *  shift before `<CardSlot>` has learned the real height. */
  "generator-runs": 115,
  /** measured — Daylesford's DeepSea grid, one row of gauge tiles (`Tile` is content-sized from
   *  `md:` up, so this sits below the 110px mobile floor). */
  "device-metrics-grid": 92,
  /** measured — the `h-48` placeholder the table variant already used, which matched. */
  "device-metrics-table": 192,
  /** measured — Daylesford + Kinkora both settle here. */
  "battery-contents": 143,
  /** estimated — `LoadProvenanceCard`: p-3/p-4 shell + header + one 4-stat row + the source split
   *  + the confidence chip row. The same box model as `battery-contents`, one row shorter. */
  "ev-provenance": 160,
  /** estimated — the plugin renders TWO things: `AmberSmallCard` (180 at full card width, where its
   *  `@[180px]` step has fired) above `AmberNow` (p-6 48 + heading 20 + mb-6 24 + the 280px circle
   *  + mb-6 24 + the feed-in row ≈ 436). */
  "amber-now": 620,
  /** estimated — `AmberCard`: p-6 (48) + heading (28) + mb-4 (16) + `AMBER_STRIP_H` (300). */
  "amber-timeline": 392,
  /** estimated — `HEATMAP_CHART_H` (600, components/HeatmapChart.tsx — not imported here, which
   *  would drag chart.js into every card that reads this table) + the panel's controls row. */
  heatmap: 700,
  /** estimated — `BatteryProvenancePanel`'s two `h-44` (176px) charts plus headers and captions. */
  "battery-provenance-history": 440,
} as const;

/**
 * The collapsed site-charts group's footprint, from the very keys the collapse pass already
 * computed (`collapseKeyOf` in v4/node-view.tsx). Additive because the block IS additive: each
 * stacked chart is a fixed-height row and the sankey is a fixed-height SVG, so Kinkora
 * (load + generation + sankey) reserves 403+403+764 = 1570 and Daylesford (sankey alone) 764 —
 * both exactly what they measure settled.
 */
export function siteChartsFootprint(keys: Iterable<string>): number {
  let h = 0;
  for (const k of keys) {
    if (k === "sankey") h += SANKEY_BLOCK;
    else if (k.startsWith("chart:")) h += STACKED_CHART_ROW;
  }
  return h;
}
