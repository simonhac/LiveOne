/**
 * The tile-grid layout policy — how a row of small cards (tiles) breaks into columns.
 *
 * A row of tiles is a CSS grid of equal columns, never a content-width flex row: every tile gets
 * the same width, `auto-rows-fr` gives every tile in a row the same height, and a tile that sizes
 * itself from its own `@container` queries (AmberSmallCard, TeslaSmallCard) gets a real width to
 * query instead of collapsing onto its `min-w` floor.
 *
 * The column count is derived from the tile count and the CONTAINER's width (not the viewport —
 * v4 groups nest, so a row group can sit in a narrow sub-group while the viewport is still "lg"):
 *
 *   cap  = clamp(floor((W + gap) / (MIN_TILE + gap)), 2, 6)   // MIN_TILE 176px, gap 16px
 *   cols = n <= cap ? n : ceil(n / ceil(n / cap))              // fewest rows, then balance them
 *
 * `cap` is how many tiles fit at a readable width; `cols` then takes the fewest rows that fit and
 * spreads the tiles evenly across them, so 8 tiles go 4x2 rather than 6+2 while 5 tiles in a wide
 * section stay 5x1. That also avoids stranding a lone tile on the last row wherever a column count
 * within the cap can avoid it (7 tiles at cap 3 can't — 3+3+1 is the only 3-row option; the test
 * pins the "only when unavoidable" property). The tiers below quantise `cap` into container-query
 * breakpoints (560/752/944/1136px).
 *
 * The table is spelled out as literal class strings because Tailwind's JIT only sees literals —
 * it can never be built by interpolation. `__tests__/tile-grid.test.ts` re-derives it from the
 * formula above so the two cannot drift.
 */

/** Layout every tile grid shares, independent of the column count. */
const GRID_BASE = "grid gap-2 @[560px]:gap-4 auto-rows-fr px-1";

/**
 * count -> the responsive `grid-cols-*` classes, one per container tier
 * (base / >=560px / >=752px / >=944px / >=1136px, i.e. caps of 2/3/4/5/6).
 */
const COLS_BY_COUNT: Record<number, string> = {
  1: "grid-cols-1 @[560px]:grid-cols-1 @[752px]:grid-cols-1 @[944px]:grid-cols-1 @[1136px]:grid-cols-1",
  2: "grid-cols-2 @[560px]:grid-cols-2 @[752px]:grid-cols-2 @[944px]:grid-cols-2 @[1136px]:grid-cols-2",
  3: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-3 @[944px]:grid-cols-3 @[1136px]:grid-cols-3",
  4: "grid-cols-2 @[560px]:grid-cols-2 @[752px]:grid-cols-4 @[944px]:grid-cols-4 @[1136px]:grid-cols-4",
  5: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-3 @[944px]:grid-cols-5 @[1136px]:grid-cols-5",
  6: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-3 @[944px]:grid-cols-3 @[1136px]:grid-cols-6",
  7: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-4 @[944px]:grid-cols-4 @[1136px]:grid-cols-4",
  8: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-4 @[944px]:grid-cols-4 @[1136px]:grid-cols-4",
  9: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-3 @[944px]:grid-cols-5 @[1136px]:grid-cols-5",
  10: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-4 @[944px]:grid-cols-5 @[1136px]:grid-cols-5",
  11: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-4 @[944px]:grid-cols-4 @[1136px]:grid-cols-6",
  12: "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-4 @[944px]:grid-cols-4 @[1136px]:grid-cols-6",
};

/** Past the table, every tier just runs at its cap. */
const COLS_AT_CAP =
  "grid-cols-2 @[560px]:grid-cols-3 @[752px]:grid-cols-4 @[944px]:grid-cols-5 @[1136px]:grid-cols-6";

/**
 * Classes for a grid of `count` tiles. The grid must sit inside an `@container` ancestor
 * (`TILE_GRID_CONTAINER`) — its breakpoints are the container's width, not the viewport's.
 */
export function tileGridClass(count: number): string {
  return `${GRID_BASE} ${COLS_BY_COUNT[count] ?? COLS_AT_CAP}`;
}

/**
 * A forced single row of equal columns, whatever the count — a `wrap: false` group. `grid-flow-col`
 * + `auto-cols-fr` needs no column table: one implicit column per child, all the same width.
 */
export function tileRowClass(): string {
  return `${GRID_BASE} grid-flow-col auto-cols-fr`;
}

/** Marks the grid's parent as the container its `@[...]` breakpoints resolve against. */
export const TILE_GRID_CONTAINER = "@container";

/** The policy constants, exported so the test can re-derive `COLS_BY_COUNT` from the formula. */
export const TILE_GRID_POLICY = {
  /** Container-query breakpoints (px) and the column cap each unlocks. Index 0 is the base tier. */
  tiers: [
    { minWidth: 0, cap: 2 },
    { minWidth: 560, cap: 3 },
    { minWidth: 752, cap: 4 },
    { minWidth: 944, cap: 5 },
    { minWidth: 1136, cap: 6 },
  ],
  maxTabulatedCount: 12,
  /** Balance `n` tiles across at most `cap` columns without orphaning a lone tile on the last row. */
  columnsFor(n: number, cap: number): number {
    if (n <= cap) return n;
    return Math.ceil(n / Math.ceil(n / cap));
  },
  /** The table under test, and the `count > maxTabulatedCount` fallback. */
  colsByCount: COLS_BY_COUNT,
  colsAtCap: COLS_AT_CAP,
} as const;
