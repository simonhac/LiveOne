/**
 * Flow direction as a chip: a coloured chevron in a grey disc (docs/architecture/tile-style.md,
 * rule 9). Replaces the chevrons that used to be glued to a tile's role icon, whose meaning flipped
 * with the icon's side of the header (left on mobile, right on desktop).
 *
 * The vocabulary is fixed so that it reads the same on every tile:
 *   - **up**   = energy leaving: export to the grid, battery discharge.
 *   - **down** = energy arriving: import from the grid, battery charge.
 *   - **idle** = a dash — within the dead band, nothing is flowing.
 *
 * `double` doubles the chevron for a large flow (the old >5 kW threshold, kept by the callers).
 */
import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Minus,
} from "lucide-react";
import { TILE_CHIP } from "@/lib/tile-style";

export type FlowDirection = "up" | "down" | "idle";

/** Below this |W| a bidirectional flow is idle — the dead band every tile has always used. */
export const FLOW_DEAD_BAND_W = 100;
/** Above this |W| the chevron doubles. */
export const FLOW_DOUBLE_W = 5000;

/**
 * Direction of a signed flow. `outWhenPositive` says which sign means "leaving": a battery's
 * positive power is discharge (up), a grid's positive power is import (down).
 */
export function flowDirection(
  watts: number,
  outWhenPositive: boolean,
): FlowDirection {
  if (Math.abs(watts) < FLOW_DEAD_BAND_W) return "idle";
  return watts > 0 === outWhenPositive ? "up" : "down";
}

export default function DirectionChip({
  direction,
  color,
  double = false,
  className,
  label,
}: {
  direction: FlowDirection;
  /** The chevron's colour — the flow's series colour, as an `rgb()` literal. */
  color: string;
  double?: boolean;
  className?: string;
  /** Accessible name — "Discharging", "Importing"… The chip itself is decoration otherwise. */
  label?: string;
}) {
  const Icon =
    direction === "idle"
      ? Minus
      : direction === "up"
        ? double
          ? ChevronsUp
          : ChevronUp
        : double
          ? ChevronsDown
          : ChevronDown;
  return (
    <span
      className={`${TILE_CHIP} ${className ?? ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Icon
        className="h-[18px] w-[18px]"
        strokeWidth={3}
        style={{
          color: direction === "idle" ? "rgba(255,255,255,0.4)" : color,
        }}
      />
    </span>
  );
}
