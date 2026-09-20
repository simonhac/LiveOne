/**
 * Tile style tokens — "silent card, loud data". See docs/architecture/tile-style.md for the rules
 * these encode; this file is the what, that one is the why.
 *
 * Mirrors `lib/charts/style.ts`: every tile surface on a dashboard takes its classes from here, so
 * "what does a tile look like" has one answer instead of the four near-identical shell strings it
 * used to have (Tile, StatCardShell, AmberSmallCard/TeslaSmallCard, GridSignalsCard).
 *
 * Class strings must stay LITERAL for Tailwind's scanner to see them — never build one by
 * interpolation.
 *
 * 🛑 THE NARROWEST TILE IS ~150px, so a `@[...]` tier below that renders for nobody. `tile-grid.ts`
 * never drops under 2 columns and never lets a column fall under 176px: a tile in a multi-tile row
 * runs ~150px (two columns on a 320px phone) to ~280px, and a tile ALONE in its row is as wide as
 * the section (~1000px) — the only two cases worth designing for. Amber and Tesla each carried two
 * dead tiers (`@[90px]`, `@[120px]`) from before that policy existed, which is how Tesla's ring came
 * to overflow at 66px with nobody noticing.
 */

/**
 * The tile's outer element: the `@container` every `@[…]` variant inside the tile resolves against,
 * and the `tile-scope` hook app/globals.css uses to set the rounded face and unit colour.
 *
 * 🛑 THE CONTAINER AND THE SURFACE ARE TWO ELEMENTS ON PURPOSE. A container query never matches the
 * container itself — `@[180px]:p-4` on the `@container` element would measure the GRID around it —
 * so the radius and padding that step up with the tile's width live one level in, on
 * {@link TILE_SURFACE}, where the tile's own width is what they see.
 *
 * `h-full` because the tile grid is `auto-rows-fr`: the grid item is stretched to the row height,
 * and the surface inside it has to follow or a short tile sits in a tall cell.
 */
export const TILE_ROOT = "tile-scope @container relative h-full min-w-0";

/**
 * The one tile surface: a neutral slab, no border, no tint, no shadow. Role never touches it.
 *
 * `--color-surface` is Apple's secondary system background (dark), `#1C1C1E`; on the true-black
 * dashboard page it reads as a card without needing an outline.
 */
export const TILE_SURFACE =
  "relative h-full overflow-hidden bg-surface rounded-[18px] @[180px]:rounded-[22px] p-3 @[180px]:p-4";

/**
 * Card title — semibold, top-left. Deliberately colourless: the header takes the tile's THEME colour
 * (`ROLE_CHROME[role].value`, white for a tile with no role) — see `TileHeader`.
 */
export const TILE_TITLE = "text-[15px] leading-tight font-semibold truncate";

/** A label over a value ("Now", "Imported"). White, regular. */
export const TILE_LABEL = "text-[13px] leading-tight text-ink";

/** Secondary text: qualifiers, time-axis labels, stale age. */
export const TILE_CAPTION =
  "text-[11px] leading-tight font-medium text-tile-ink-muted";

/**
 * A caption whose UNITS read a step quieter than its numbers — the Home Energy footer, which packs
 * five facts onto one line.
 *
 * A deliberate exception to tile-style rule 5 ("units take the value's colour"). That rule is about
 * a HERO, where a grey `kW` beside a yellow number would split one fact into two tones. Here the
 * numbers are what the eye is scanning for and the units are the furniture between them.
 *
 * 🛑 `!` IS LOAD-BEARING. `.tile-scope [data-unit] { color: inherit }` (app/globals.css) is
 * deliberately UNLAYERED so it outranks the `text-ink-muted` utility `<Value>` carries outside a
 * tile — which means a plain utility here loses to it too, at any specificity. Only `!important`
 * wins, the same trick the Home Energy skeleton already uses for `!text-transparent`.
 */
export const TILE_CAPTION_UNITS_DIM = "[&_[data-unit]]:!text-tile-ink-idle";

/** A time-axis label under a mini chart — a caption a size down, since four share a 150px tile. */
export const TILE_TICK =
  "text-[10px] leading-none font-medium text-tile-ink-muted";

/**
 * The one hero number per tile. Colour is the caller's — it is the DATA's colour.
 *
 * Two steps, not three: the old 22px base was gated at `@[130px]`, under the ~150px floor
 * above, so nothing ever rendered it.
 */
export const TILE_HERO =
  "text-[28px] @[220px]:text-[34px] font-bold leading-none tabular-nums";

/** A supporting value (a Trends row's number). */
export const TILE_VALUE_2 = "text-[17px] leading-tight font-bold tabular-nums";

/**
 * The one ring size. Every tile whose data is a circle — Battery and EV's SoC rings, Amber's price
 * disc, the NEM grid's renewables ring — sizes it with this, so a row of them reads as one set
 * rather than four near-miss diameters. 76px until the tile is 180px wide, then 108px.
 */
export const TILE_RING =
  "h-[76px] w-[76px] shrink-0 @[180px]:h-[108px] @[180px]:w-[108px]";

/** The number in the middle of a {@link TILE_RING}. Colour is the caller's. */
export const TILE_RING_VALUE =
  "text-[17px] @[180px]:text-[24px] font-bold leading-none";

/** The grey disc a direction chevron or a control glyph sits in. */
export const TILE_CHIP =
  "size-7 shrink-0 rounded-full bg-wash grid place-items-center";

/**
 * Added to a LIVE value (a hero, a ring, a row) while its reading is stale: the value keeps its hue
 * and dims. Never a replacement colour — greying a stale value erased the one thing the tile is
 * (the solar tile's yellow, the renewables ring's green) exactly when the feed lagged, which on a
 * dev machine is always. The header's stale badge says how old it is.
 */
export const TILE_STALE = "opacity-55";

/** Radius for a tile-shaped PLACEHOLDER (no container of its own to step up against). */
export const TILE_SKELETON_RADIUS = "rounded-[20px]";

/**
 * Time-axis tick labels for tile mini-charts, as the 24h bars and the hot-water line draw them.
 * Local hours (in the tile subject's timezone), and the words the Activity app uses.
 */
export const DAY_TICK_HOURS = [0, 6, 12, 18] as const;
export function dayTickLabel(hour: number): string {
  if (hour === 0) return "12 am";
  if (hour === 12) return "12 pm";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}
