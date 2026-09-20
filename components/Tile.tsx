import React from "react";
import Value from "@/components/ui/value";
import TileSurface, { TileHeader } from "@/components/ui/tile-surface";
import { useStaleness } from "@/components/ui/tile-stale";
import {
  TILE_CAPTION,
  TILE_HERO,
  TILE_LABEL,
  TILE_STALE,
} from "@/lib/tile-style";

interface TileProps {
  title: string;
  /** The role glyph in the header. */
  icon?: React.ReactNode;
  /** The tile's THEME colour (`ROLE_CHROME[role].value`) — the header's icon and title. */
  tone?: string;
  value: string;
  /** Unit to display after value (e.g. "kW", "%", "°C"). Binding is decided by `classifyUnit`. */
  unit?: string;
  /** A label over the hero ("Now") — the Activity app's "Today" line. */
  label?: React.ReactNode;
  staleThresholdSeconds: number;
  measurementTime?: Date;
  /** The qualifying line under the hero. A node, not a string: a tile may need to colour part of
   *  it (the generator's countdown) without the whole line changing tone. */
  extraInfo?: React.ReactNode;
  /**
   * Tailwind text colour for the HERO and its unit — the DATA's colour, which is where a tile's
   * identity lives (`ROLE_CHROME[role].value`). Defaults to white: a value with no series of its
   * own has no colour. Dims (`TILE_STALE`), keeping its hue, while the reading is stale.
   */
  valueColor?: string;
  /** Extra classes on the hero value itself — e.g. the running generator's shimmer. */
  valueClassName?: string;
  /** Beside the hero, right-aligned — e.g. the generator's countdown ring. */
  heroAside?: React.ReactNode;
  /** Top-right of the header: a direction chip, a control. */
  accessory?: React.ReactNode;
  /** The body under the hero: bars, Trends rows. */
  extra?: React.ReactNode;
  /** Absolutely-positioned chrome inside the surface — see `TileSurfaceProps.overlay`. */
  overlay?: React.ReactNode;
}

/**
 * The standard tile: title, one hero value, then whatever supports it. "Silent card, loud data" —
 * see docs/architecture/tile-style.md. The card is the same neutral slab for every role; colour
 * arrives only through `valueColor` and the body the plugin draws.
 *
 * Stale is quiet: no hatch and no dimmed box. The live hero dims (keeping its hue) and the header carries a
 * clock + the reading's age, with the exact time on hover; period data in the body keeps its colour.
 */
export default function Tile({
  title,
  icon,
  tone,
  value,
  unit,
  label,
  staleThresholdSeconds,
  measurementTime,
  extraInfo,
  extra,
  overlay,
  accessory,
  heroAside,
  valueColor,
  valueClassName,
}: TileProps) {
  const staleness = useStaleness(measurementTime, staleThresholdSeconds);
  const heroColor = `${valueColor ?? "text-ink"} ${staleness.isStale ? TILE_STALE : ""}`;

  return (
    <TileSurface overlay={overlay} surfaceClassName="flex flex-col">
      <TileHeader
        title={title}
        icon={icon}
        tone={tone}
        accessory={accessory}
        staleness={staleness}
        measurementTime={measurementTime}
      />
      {label && <p className={`mt-1.5 ${TILE_LABEL}`}>{label}</p>}
      <div
        className={`flex items-center justify-between gap-2 ${label ? "mt-0.5" : "mt-1.5"}`}
      >
        <p className={`${TILE_HERO} ${heroColor} min-w-0`}>
          <Value value={value} unit={unit} className={valueClassName} />
        </p>
        {heroAside}
      </div>
      {extraInfo && <p className={`mt-1 ${TILE_CAPTION}`}>{extraInfo}</p>}
      {extra && (
        // Never greyed when stale: the body is the period's bars and totals, which a lagging live
        // feed does not make wrong. Only the LIVE hero dims (`TILE_STALE`).
        <div className="mt-2 flex flex-1 flex-col">{extra}</div>
      )}
    </TileSurface>
  );
}
