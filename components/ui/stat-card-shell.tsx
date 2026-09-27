"use client";

import TileSurface, { TileHeader } from "@/components/ui/tile-surface";
import { useStaleness } from "@/components/ui/tile-stale";
import { TILE_CAPTION } from "@/lib/tile-style";

export interface StatCardShellProps {
  title: string;
  /** Quiet text immediately after the title — e.g. the period ("24 hours"). */
  titleSuffix?: string;
  /** The role glyph before the title, sized by the header. */
  icon?: React.ReactNode;
  /**
   * The card's THEME colour — `ROLE_CHROME[role].value`. Takes the icon AND the title together, as
   * on a tile, so a card names its role in the colour that role has in every chart.
   */
  tone?: string;
  /** Newest contributing reading; absent ⇒ treated as permanently stale. */
  measurementTime?: Date;
  staleThresholdSeconds?: number;
  /**
   * Set for a card that reports a PERIOD (a 30-day provenance summary) rather than a live reading:
   * there is no instant for it to be stale relative to, so the header shows no age badge.
   *
   * 🛑 This cannot be expressed by omitting `measurementTime`. Absent means "permanently stale"
   * (`useStaleness` reads a missing time as an infinite age), so a period card that simply passed
   * nothing would render a "no data" badge forever.
   */
  periodReport?: boolean;
  children: React.ReactNode;
}

/**
 * The frame shared by the labelled-stat cards (battery contents, home energy): the tile surface,
 * the header (title · period · stale age), and nothing else. Same surface and header as `Tile`
 * (components/ui/tile-surface.tsx); body content is the caller's.
 */
export default function StatCardShell({
  title,
  titleSuffix,
  icon,
  tone,
  measurementTime,
  staleThresholdSeconds = 900,
  periodReport = false,
  children,
}: StatCardShellProps) {
  // The hook runs unconditionally (it must); a period card just discards the result.
  const tracked = useStaleness(measurementTime, staleThresholdSeconds);
  const staleness = periodReport ? undefined : tracked;
  return (
    <TileSurface>
      <TileHeader
        className="mb-2"
        icon={icon}
        tone={tone}
        title={
          <>
            {title}
            {titleSuffix && (
              <span className={`ml-2 ${TILE_CAPTION}`}>{titleSuffix}</span>
            )}
          </>
        }
        staleness={staleness}
        measurementTime={measurementTime}
      />
      {children}
    </TileSurface>
  );
}
