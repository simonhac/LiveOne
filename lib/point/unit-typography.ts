/**
 * How a unit binds to the number in front of it.
 *
 * The single source of truth for the tight-vs-spaced question, replacing three
 * contradictory ad-hoc rules (`Tile`'s `unit !== "%"`, `BatteryContentsCard`'s
 * `gap = true` default and `GridSignalsCard`'s `gap = false` default).
 *
 * The distinction is typographic, not dimensional: `%`, `°C` and `¢` are glyph
 * modifiers that read as part of the number, so they fuse to it and keep the
 * number's colour. Alphabetic symbols (`kW`, `kWh`, `g`, `rpm`, …) stand for a
 * word, so they take a hair space and a muted colour.
 *
 * See docs/architecture/number-typography.md.
 */

/** Units that fuse to the number and are NOT muted. */
const TIGHT_UNITS = new Set(["%", "°", "°C", "°F", "¢", "$", "c"]);

export type UnitGap = "none" | "hair" | "word";

export interface UnitParts {
  /** The unit up to the first `/` — e.g. `¢` of `¢/kWh`. May be empty. */
  head: string;
  /** The `/`-prefixed denominator — e.g. `/kWh`. Always tight + muted. May be empty. */
  tail: string;
  headGap: UnitGap;
  headMuted: boolean;
}

export function isTightUnit(unit: string): boolean {
  return TIGHT_UNITS.has(unit);
}

/**
 * Split a (possibly compound) unit into its head and denominator tail and decide
 * how each binds. `"¢/kWh"` -> head `¢` (tight, unmuted) + tail `/kWh` (tight,
 * muted); `"g/kWh"` -> head `g` (hair, muted) + tail `/kWh`.
 */
export function classifyUnit(unit: string): UnitParts {
  const slash = unit.indexOf("/");
  const head = slash === -1 ? unit : unit.slice(0, slash);
  const tail = slash === -1 ? "" : unit.slice(slash);

  // An empty head (e.g. "/MWh") has nothing to space or mute.
  const tight = head === "" || isTightUnit(head);

  return {
    head,
    tail,
    headGap: tight ? "none" : "hair",
    headMuted: !tight && head !== "",
  };
}

/**
 * Left margins for the unit span, expressed in the span's OWN em — which is
 * `UNIT_SCALE` of the hero size, so the rendered gaps are ~0.08em and ~0.30em of
 * the hero. Never use a literal space character: it is full-width and renders
 * differently across DM Sans and TT Interphases Pro.
 */
export const UNIT_SCALE = 0.72;
export const GAP_CLASS: Record<UnitGap, string> = {
  none: "",
  hair: "ml-[0.11em]",
  word: "ml-[0.42em]",
};

/** Shared typography for every non-number part of a hero value. */
export const UNIT_CLASS = "text-[0.72em] font-semibold";
export const UNIT_MUTED_CLASS = "text-gray-400";
