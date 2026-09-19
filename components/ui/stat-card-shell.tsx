"use client";

import TileSurface, { TileHeader } from "@/components/ui/tile-surface";
import { useStaleness } from "@/components/ui/tile-stale";
import { TILE_CAPTION } from "@/lib/tile-style";

export interface StatCardShellProps {
  title: string;
  /** Quiet text immediately after the title — e.g. the period ("24 hours"). */
  titleSuffix?: string;
  /** Newest contributing reading; absent ⇒ treated as permanently stale. */
  measurementTime?: Date;
  staleThresholdSeconds?: number;
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
  measurementTime,
  staleThresholdSeconds = 900,
  children,
}: StatCardShellProps) {
  const staleness = useStaleness(measurementTime, staleThresholdSeconds);
  return (
    <TileSurface>
      <TileHeader
        className="mb-2"
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
