/**
 * A tile's role colour, derived from the chart palette.
 *
 * Tiles and charts drifted apart because nothing connected them: tiles wrote Tailwind class strings
 * per-plugin, charts wrote `rgb()` literals in `lib/chart-colors.ts`, and the only link was a
 * hand-copied comment. Load and Hot Water happened to match their series exactly; Solar's icon
 * quietly diverged (yellow-400 vs the series' yellow-200) and nothing noticed.
 *
 * 🛑 **Colour is data, never chrome** (docs/architecture/tile-style.md). The tile surface is one
 * neutral slab for every role — no role border, no role tint. The role's colour goes on the DATA: the
 * hero value, its unit, the ring, the bars and the direction chevron. So each role carries exactly
 * two spellings of one colour:
 *
 *   - **value** = a `--color-series-*` text class, for the hero number and its unit.
 *   - **rgb**   = the SAME colour as an `rgb()` literal, for SVG strokes and fills (rings, bars).
 *
 * `role-chrome.test.ts` asserts the class really does resolve to the `CHART_COLORS` value and that
 * `rgb` IS that value, so a Solar-style drift fails the build rather than shipping.
 *
 * 🛑 THE CLASSES ARE SERIES TOKENS, NOT `text-green-400`. They used to be Tailwind palette classes,
 * and that quietly reintroduced the very drift above: Tailwind v4's palette is `oklch`, tuned more
 * vivid than the v3 sRGB hexes these `rgb` values are, so a tile's number and the ring beside it
 * were two different greens on any wide-gamut display. The test could not see it because its
 * lookup table was a hand-copied v3 table. The token block in app/globals.css now defines
 * `--color-series-*` AS these values, and the test reads that CSS rather than a table.
 *
 * 🛑 **Identity, not state.** These colours say *what a tile is*, never *what it is doing*. Battery
 * and Grid used to colour by the sign of their power, which made green mean "charging" on one tile
 * and "exporting" on the next. Direction rides on the direction chip instead. The one state variant
 * kept is idle — *absence of flow*, not a direction — see `IDLE_CHROME`.
 *
 * Genuine scales — Tesla's SoC ramp, Amber's price levels — are correctly state-coded and are
 * deliberately NOT modelled here.
 *
 * Class strings must stay literal for Tailwind's scanner to see them; do not build them by
 * interpolation.
 */
import { CHART_COLORS } from "@/lib/chart-colors";

export interface RoleChrome {
  /** Tailwind text colour for the hero value — the series colour exactly. */
  value: string;
  /** The same colour as an `rgb()` literal, for SVG. */
  rgb: string;
}

export const ROLE_CHROME = {
  solar: { value: "text-series-solar", rgb: CHART_COLORS.solar.primary },
  load: { value: "text-series-load", rgb: CHART_COLORS.load },
  hotWater: { value: "text-series-hot-water", rgb: CHART_COLORS.hotWater },
  battery: { value: "text-series-battery", rgb: CHART_COLORS.battery.main },
  grid: { value: "text-series-grid", rgb: CHART_COLORS.grid.main },
  pool: { value: "text-series-pool", rgb: CHART_COLORS.pool },
  hvac: { value: "text-series-hvac", rgb: CHART_COLORS.hvac },
  ev: { value: "text-series-ev", rgb: CHART_COLORS.ev },
  /** Tiles with no series of their own (device metrics, generic gauges): no role, no colour. */
  neutral: { value: "text-ink", rgb: "rgb(255, 255, 255)" },
} as const satisfies Record<string, RoleChrome>;

/**
 * The one retained state variant: nothing is flowing. Applies to the bidirectional tiles (Battery,
 * Grid) inside the 100 W dead band. Expressed in the DATA — the value greys — never by greying the
 * box. Stale is NOT this: a stale value keeps its hue and dims (`TILE_STALE`) — it is the last
 * thing we knew, not an absence of flow.
 */
export const IDLE_CHROME: RoleChrome = {
  value: "text-tile-ink-idle",
  rgb: "rgba(255, 255, 255, 0.4)",
};
