/**
 * Tile chrome, derived from the chart palette.
 *
 * Tiles and charts drifted apart because nothing connected them: tiles wrote Tailwind class strings
 * per-plugin, charts wrote `rgb()` literals in `lib/chart-colors.ts`, and the only link was a
 * hand-copied comment. Load and Hot Water happened to match their series exactly; Solar's icon
 * quietly diverged (yellow-400 vs the series' yellow-200) and nothing noticed.
 *
 * The rule, in one place:
 *
 *   - **icon**   = the EXACT series colour from `CHART_COLORS`. A 24px glyph at full chroma is
 *                  precisely the size where an exact match reads as "this is that thing".
 *   - **border** = the same hue at `-700`.
 *   - **tint**   = the same hue at `-900/20`. A 300×150 panel filled at series chroma would
 *                  out-shout the chart it is meant to point at.
 *   - numbers and titles stay neutral — never tinted.
 *
 * `role-chrome.test.ts` asserts the icon class really does resolve to the `CHART_COLORS` value, so
 * the Solar-style drift fails the build rather than shipping.
 *
 * 🛑 **Identity, not state.** These colours say *what a tile is*, never *what it is doing*. Battery
 * and Grid used to colour by the sign of their power, which made green mean "charging" on one tile
 * and "exporting" on the next, and put Grid in red while the Grid *series* is magenta. Direction now
 * rides on the chevron and the label text ("Discharging 2.2kw", "Imported 19.5kWh"). The one state
 * variant kept is the grey idle treatment, which signals *absence of flow* rather than a direction —
 * see `IDLE_CHROME`.
 *
 * Genuine scales — Tesla's SoC ramp, Amber's price levels — are correctly state-coded and live in
 * neutral-chrome cards. They are deliberately NOT modelled here.
 *
 * Class strings must stay literal for Tailwind's scanner to see them; do not build them by
 * interpolation.
 */

export interface RoleChrome {
  /** Tailwind text colour for the tile's icon — matches the series colour exactly. */
  icon: string;
  /** Tailwind border colour: the role's hue at -700. */
  border: string;
  /** Tailwind background tint: the role's hue at -900/20. */
  tint: string;
}

export const ROLE_CHROME = {
  solar: {
    icon: "text-yellow-200",
    border: "border-yellow-700",
    tint: "bg-yellow-900/20",
  },
  load: {
    icon: "text-blue-400",
    border: "border-blue-700",
    tint: "bg-blue-900/20",
  },
  hotWater: {
    icon: "text-orange-400",
    border: "border-orange-700",
    tint: "bg-orange-900/20",
  },
  battery: {
    icon: "text-green-400",
    border: "border-green-700",
    tint: "bg-green-900/20",
  },
  grid: {
    icon: "text-pink-500",
    border: "border-pink-700",
    tint: "bg-pink-900/20",
  },
  pool: {
    icon: "text-cyan-400",
    border: "border-cyan-700",
    tint: "bg-cyan-900/20",
  },
  hvac: {
    icon: "text-violet-400",
    border: "border-violet-700",
    tint: "bg-violet-900/20",
  },
  /** Tiles with no series of their own (device metrics, generic gauges). */
  neutral: {
    icon: "text-slate-400",
    border: "border-gray-700",
    tint: "bg-gray-800/50",
  },
} as const satisfies Record<string, RoleChrome>;

export type ChromeRole = keyof typeof ROLE_CHROME;

/**
 * The one retained state variant: nothing is flowing. Applies to the bidirectional tiles (Battery,
 * Grid) when power is within the dead band. This is an absence signal, not a direction signal, so it
 * doesn't recreate the "green means two different things" ambiguity that the sign-keyed chrome had.
 */
export const IDLE_CHROME: RoleChrome = {
  icon: "text-gray-400",
  border: "border-gray-700",
  tint: "bg-gray-900/20",
};
