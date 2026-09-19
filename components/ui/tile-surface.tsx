/**
 * The tile shell every dashboard tile is drawn in — "silent card, loud data"
 * (docs/architecture/tile-style.md). One neutral surface, no border, no tint; the header is a white
 * title with an optional accessory (a direction chip, a control cog) and the stale badge.
 *
 * Replaces the four hand-copied shell strings Tile, StatCardShell, AmberSmallCard/TeslaSmallCard and
 * GridSignalsCard each carried.
 */
import React from "react";
import { ttInterphases } from "@/lib/fonts/amber";
import { TILE_ROOT, TILE_SURFACE, TILE_TITLE } from "@/lib/tile-style";
import { StaleBadge, type Staleness } from "@/components/ui/tile-stale";

export interface TileSurfaceProps {
  children: React.ReactNode;
  /** Extra classes on the OUTER element (the `@container`) — e.g. a min-width floor. */
  className?: string;
  /** Extra classes on the SURFACE (inside the container) — e.g. a flex column, a min-height. */
  surfaceClassName?: string;
  /**
   * Absolutely-positioned chrome inside the surface — a control cog, a dialog.
   *
   * 🛑 THIS EXISTS SO A TILE NEVER WRAPS ITSELF IN A POSITIONING DIV. The tile grid is
   * `auto-rows-fr` (lib/dashboard/tile-grid.ts): every grid ITEM is stretched to the row height. A
   * plugin that returns `<div className="relative"><Tile/></div>` makes the DIV the grid item and
   * the tile inside it stays at content height. The surface is already `relative`.
   */
  overlay?: React.ReactNode;
  rootRef?: React.Ref<HTMLDivElement>;
}

export default function TileSurface({
  children,
  className,
  surfaceClassName,
  overlay,
  rootRef,
}: TileSurfaceProps) {
  return (
    <div
      ref={rootRef}
      className={`${TILE_ROOT} ${ttInterphases.variable} ${className ?? ""}`}
    >
      <div className={`${TILE_SURFACE} ${surfaceClassName ?? ""}`}>
        {overlay}
        {children}
      </div>
    </div>
  );
}

/**
 * The header row: title top-left; stale badge, then the accessory, top-right.
 *
 * `min-h-7` is the chip's height, so a tile with a chip and a tile without one put their first line
 * of data at the same height when they sit side by side.
 */
export function TileHeader({
  title,
  icon,
  tone,
  accessory,
  staleness,
  measurementTime,
  className,
}: {
  title: React.ReactNode;
  /** The role glyph before the title, sized by the header. */
  icon?: React.ReactNode;
  /**
   * The tile's THEME colour — `ROLE_CHROME[role].value`. The icon and title take it, the way an iOS
   * widget's header does, so a tile names its role in the same colour its series has in every
   * chart. Defaults to white: a tile with no role has no theme.
   */
  tone?: string;
  accessory?: React.ReactNode;
  staleness?: Staleness;
  measurementTime?: Date | number | null;
  className?: string;
}) {
  return (
    <div className={`flex min-h-7 items-center gap-2 ${className ?? ""}`}>
      <div
        className={`flex min-w-0 flex-1 items-center gap-1.5 ${tone ?? "text-white"}`}
      >
        {icon && (
          <span aria-hidden className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">
            {icon}
          </span>
        )}
        <span className={`min-w-0 ${TILE_TITLE}`}>{title}</span>
      </div>
      {staleness?.isStale && staleness.ageLabel && (
        <StaleBadge
          ageLabel={staleness.ageLabel}
          measurementTime={measurementTime}
        />
      )}
      {accessory && (
        <div className="flex shrink-0 items-center gap-1.5">{accessory}</div>
      )}
    </div>
  );
}
