/**
 * THE loading placeholders. Every "we don't have this yet" box on a dashboard is one of these.
 *
 * They live in ui/ rather than beside the cards because the leaf components use them too
 * (HomeEnergyCard, HeatmapPanel, DeviceMetricsCard, …), and those must not have to import
 * dashboard/cards/shared.tsx — which drags in react-query and the whole `/api/data` plumbing — just
 * to draw a grey rectangle. `components/dashboard/cards/shared.tsx` re-exports them for the card
 * layer, so there is still one import site per audience and one implementation.
 *
 * THE RULE THESE ENCODE: a placeholder is the SIZE OF THE THING IT REPLACES. A dashboard's cards
 * each own their own query and none of those are SSR-prefetched, so every card is a placeholder for
 * a moment; if the placeholder is the wrong size, the page relayouts under the reader as each one
 * resolves. Prefer a STRUCTURAL skeleton (same wrapper, same grid classes, same box model, e.g.
 * `StatGridSkeleton`) over a fixed height wherever the real content's height is responsive — a
 * magic number can only be right at the one width it was measured at.
 */
import React from "react";

/**
 * The class every placeholder wears.
 *
 * `data-skeleton` marks a subtree as "still a placeholder". Nothing in the render path branches on
 * it — it is there for MEASUREMENT: the layout-stability probe reads it to tell a reserved box from
 * the settled card, which is how you check that a footprint is right rather than merely stable.
 * (See the recipe in docs/performance/dashboard-layout-stability.md.) Every placeholder in the
 * dashboard tree — host-drawn, or drawn by a leaf component's own loading branch — should carry it.
 */
export const SKELETON_CLASS =
  "animate-pulse rounded-lg border border-gray-700/50 bg-gray-800/30";

/**
 * A tile-shaped placeholder, shown while a tile cell's `/api/data` is in flight.
 *
 * The sizing MIRRORS the real tiles rather than picking a round number: `Tile` is
 * `min-h-[110px] md:min-h-0` (content-sized once there is room), and the two container-query tiles
 * (AmberSmallCard / TeslaSmallCard) step up at `@[180px]`. A tile row is `auto-rows-fr`, so a
 * placeholder TALLER than the real tile drags the whole row down and then snaps back — which is
 * exactly how the old flat `min-h-[120px]` shifted the row it was meant to stabilise. `className`
 * carries the plugin's own `TilePlugin.skeletonClass`, for the tiles that size themselves.
 */
export function TileSkeleton({ className }: { className?: string }) {
  return (
    <div
      data-skeleton=""
      // 110 is `Tile`'s own mobile floor. 91 is what a `Tile` MEASURES from `md:` up, where it drops
      // that floor (`md:min-h-0`) and sizes to its content — a skeleton left on 110 there would sit
      // 19px taller than the tiles it stands in for and shrink the row on arrival.
      className={`min-h-[110px] md:min-h-[91px] ${className ?? ""} ${SKELETON_CLASS}`}
    />
  );
}

/**
 * The non-tile card placeholder: a box of the card's DECLARED footprint (`CardPlugin.footprint` —
 * see components/dashboard/cards/footprints.ts for where those numbers come from).
 *
 * `height`, not `min-height`: the point is to occupy exactly the space the card will occupy, so the
 * content landing is a swap and not a resize.
 */
export function CardSkeleton({
  height,
  className,
}: {
  height: number;
  className?: string;
}) {
  return (
    <div
      data-skeleton=""
      style={{ height }}
      className={`${className ?? ""} ${SKELETON_CLASS}`}
    />
  );
}

/**
 * A stat-grid placeholder for the `StatCardShell`-shaped cards (home energy, EV provenance, battery
 * contents). Structural rather than a fixed height: it reuses the SAME responsive grid classes and
 * the same `Stat` box model (hero line + caption), so it measures the same at every container width
 * instead of being right at one and wrong at the rest.
 */
export function StatGridSkeleton({
  cells = 4,
  gridClassName = "grid grid-cols-2 gap-x-4 gap-y-3 @[360px]:grid-cols-3 @[520px]:grid-cols-4",
}: {
  cells?: number;
  gridClassName?: string;
}) {
  return (
    <div data-skeleton="" className={gridClassName} aria-hidden>
      {Array.from({ length: cells }).map((_, i) => (
        <div key={i} className="animate-pulse">
          {/* `Stat`'s hero line: text-xl leading-none md:text-2xl */}
          <div className="h-5 rounded bg-gray-700/40 md:h-6" />
          {/* `Stat`'s caption: mt-1 text-[10px] md:text-xs */}
          <div className="mt-1 h-3 w-2/3 rounded bg-gray-700/30 md:h-4" />
        </div>
      ))}
    </div>
  );
}
