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
 *   - **value** = a Tailwind text class, for the hero number and its unit.
 *   - **rgb**   = the SAME colour as an `rgb()` literal, for SVG strokes and fills (rings, bars).
 *
 * `role-chrome.test.ts` asserts the class really does resolve to the `CHART_COLORS` value and that
 * `rgb` IS that value, so a Solar-style drift fails the build rather than shipping.
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
  solar: { value: "text-yellow-200", rgb: CHART_COLORS.solar.primary },
  load: { value: "text-blue-400", rgb: CHART_COLORS.load },
  hotWater: { value: "text-orange-400", rgb: CHART_COLORS.hotWater },
  battery: { value: "text-green-400", rgb: CHART_COLORS.battery.main },
  grid: { value: "text-pink-500", rgb: CHART_COLORS.grid.main },
  pool: { value: "text-cyan-400", rgb: CHART_COLORS.pool },
  hvac: { value: "text-violet-400", rgb: CHART_COLORS.hvac },
  ev: { value: "text-red-600", rgb: CHART_COLORS.ev },
  /** Tiles with no series of their own (device metrics, generic gauges): no role, no colour. */
  neutral: { value: "text-white", rgb: "rgb(255, 255, 255)" },
} as const satisfies Record<string, RoleChrome>;

/**
 * The one retained state variant: nothing is flowing. Applies to the bidirectional tiles (Battery,
 * Grid) inside the 100 W dead band. Expressed in the DATA — the value greys — never by greying the
 * box. Stale is NOT this: a stale value keeps its hue and dims (`TILE_STALE`) — it is the last
 * thing we knew, not an absence of flow.
 */
export const IDLE_CHROME: RoleChrome = {
  value: "text-white/40",
  rgb: "rgba(255, 255, 255, 0.4)",
};
