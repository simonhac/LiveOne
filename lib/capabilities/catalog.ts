/**
 * The card / tile CATALOG — the declarative, capability-keyed replacement for the vendor-string logic
 * in lib/dashboard/cards.ts (`getLayout`, `isSiteVendor`, `availableTiles`, the dead `CARD_REGISTRY`/
 * `TILES`) and the `card.type` switch in components/Dashboard.tsx.
 *
 * Each entry declares the capabilities it REQUIRES. "Which cards/tiles can an area show" =
 * `CATALOG.filter(e => satisfies(scopeCaps(e), e.requires))`. No vendor/device names appear here — a
 * device the presentation layer has never seen lights up the right cards purely via its advertised
 * capabilities.
 *
 * TWO NON-NEGOTIABLE CONTRACTS:
 *  1. **`scope`** — `requires` is checked against the AREA UNION for `scope: "area"` entries, and
 *     against a SPECIFIC MEMBER's capability set for `scope: "device"` entries (`generator-runs`,
 *     `oe-grid`, `device-metrics` already carry a `deviceSystemId` in the v3 descriptor).
 *  2. **Eligibility ≠ render authority** — this filter is for the Add-Card GALLERY (grey-out) and the
 *     default-dashboard strategy ONLY. It is NEVER the final say on whether a card renders. Renderers
 *     keep their own gate: the sankey still checks `selectFlowMatrix` for *directional* flow (presence
 *     of solar+load is not enough); `oe-grid`/`grid-signals` still resolves a NEM region. Do NOT
 *     "simplify" a renderer to trust this filter — it will ship blank/incorrect cards.
 *
 * This module is additive and INERT until the P4 cutover — nothing renders from it yet, exactly as the
 * dead `CARD_REGISTRY` sat inert. The equivalence test pins that `availableTilesFromCaps ∘
 * capabilitiesFromLatest` reproduces today's `availableTiles`, so the cutover is byte-identical.
 */

import type { CapabilityId } from "@/lib/capabilities/registry";
import type { CapabilitySet } from "@/lib/capabilities/derive";

/** A capability requirement: ALL of a set, or ANY of a set. */
export type CapReq = { all: CapabilityId[] } | { any: CapabilityId[] };

export function satisfies(caps: CapabilitySet, req: CapReq): boolean {
  if ("all" in req) return req.all.every((c) => caps.has(c));
  return req.any.some((c) => caps.has(c));
}

/** Whether a capability requirement references at least one capability at all (non-empty). */
export function isSatisfiable(req: CapReq): boolean {
  return ("all" in req ? req.all : req.any).length > 0;
}

// ============================================================================
// Tiles — the individually-toggleable cards inside the `tiles` container.
// Order MUST match lib/dashboard/cards.ts:TILE_IDS (asserted in the equivalence test) until the
// catalog becomes the sole source at cutover.
// ============================================================================

export type TileId =
  | "solar"
  | "load"
  | "hotWater"
  | "battery"
  | "house-to-grid"
  | "amber"
  | "ev";

export interface TileCatalogEntry {
  id: TileId;
  label: string;
  requires: CapReq;
}

/**
 * Requirements chosen to reproduce `availableTiles(latest)` EXACTLY on the realistic path universe:
 *  - `load` is satisfied by ANY source (the load card synthesises a master load from any source when
 *    no dedicated load point exists) — hence `{ any: [load/power, solar/power, battery/power,
 *    grid/power] }`, mirroring the current `anyLoad || solar || battery || grid` disjunction.
 */
export const TILE_CATALOG: Record<TileId, TileCatalogEntry> = {
  solar: { id: "solar", label: "Solar", requires: { all: ["solar/power"] } },
  load: {
    id: "load",
    label: "Load",
    requires: {
      any: ["load/power", "solar/power", "battery/power", "grid/power"],
    },
  },
  hotWater: {
    id: "hotWater",
    label: "Hot Water",
    requires: { all: ["load.hws/temperature"] },
  },
  battery: {
    id: "battery",
    label: "Battery",
    requires: { all: ["battery/soc"] },
  },
  "house-to-grid": {
    id: "house-to-grid",
    label: "Grid",
    requires: { all: ["grid/power"] },
  },
  amber: {
    id: "amber",
    label: "Amber Price",
    requires: { all: ["grid/rate"] },
  },
  ev: { id: "ev", label: "EV", requires: { all: ["ev/soc"] } },
};

/** Canonical tile order (mirrors TILE_IDS). */
export const TILE_ORDER: readonly TileId[] = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
];

/** Which tiles an area/device with `caps` can show, in canonical order — replaces `availableTiles`. */
export function availableTilesFromCaps(caps: CapabilitySet): TileId[] {
  return TILE_ORDER.filter((id) => satisfies(caps, TILE_CATALOG[id].requires));
}

// ============================================================================
// Cards — the descriptor-level modules. `scope: "device"` cards read a bound member (deviceSystemId).
// ============================================================================

export type CardId =
  | "tiles"
  | "chart"
  | "sankey"
  | "amber-now"
  | "amber-timeline"
  | "generator-runs"
  | "device-metrics"
  | "oe-grid"
  | "battery-blend"
  | "ev-provenance";

export interface CardCatalogEntry {
  id: CardId;
  label: string;
  requires: CapReq;
  scope: "area" | "device";
  /** For `scope: "device"` cards: the capability the bound member must provide. */
  bindsCapability?: CapabilityId;
}

/**
 * The card catalog. `chart`/`sankey` eligibility is `{ all: ["solar/power"] }` — this is EXACTLY
 * `chartHasData(latest)`, which reduces to "has solar" (its `load` disjunct always includes `solar`,
 * so `solar && load ≡ solar`). The renderer keeps the real "is there directional flow" gate
 * (`selectFlowMatrix`) — see contract #2 above.
 */
export const CARD_CATALOG: Record<CardId, CardCatalogEntry> = {
  tiles: {
    id: "tiles",
    label: "Tiles",
    scope: "area",
    // Any tile-eligible capability (i.e. not a pricing-only area).
    requires: {
      any: [
        "solar/power",
        "load/power",
        "battery/soc",
        "battery/power",
        "grid/power",
        "ev/soc",
        "load.hws/temperature",
      ],
    },
  },
  chart: {
    id: "chart",
    label: "Power Chart",
    scope: "area",
    requires: { all: ["solar/power"] },
  },
  sankey: {
    id: "sankey",
    label: "Energy Flows",
    scope: "area",
    requires: { all: ["solar/power"] },
  },
  "amber-now": {
    id: "amber-now",
    label: "Amber Price",
    scope: "area",
    requires: { all: ["grid/rate"] },
  },
  "amber-timeline": {
    id: "amber-timeline",
    label: "Amber Forecast",
    scope: "area",
    requires: { all: ["grid/rate"] },
  },
  "generator-runs": {
    id: "generator-runs",
    label: "Generator Runs",
    scope: "device",
    requires: { all: ["generator-running"] },
    bindsCapability: "generator-running",
  },
  "device-metrics": {
    id: "device-metrics",
    label: "Device Metrics",
    scope: "device",
    requires: { all: ["instrumentation"] },
  },
  "oe-grid": {
    id: "oe-grid",
    label: "Local Grid (NEM)",
    scope: "device",
    requires: { all: ["grid-signals"] },
    bindsCapability: "grid-signals",
  },
  // Area-derived provenance cards — gated on a battery being present (the blend needs one). Both read
  // engine OUTPUTS (the KV-latest blend keys / the ?source=modern flow matrix), not engine internals.
  "battery-blend": {
    id: "battery-blend",
    label: "Battery Blend",
    scope: "area",
    requires: { all: ["battery/power"] },
  },
  "ev-provenance": {
    id: "ev-provenance",
    label: "EV Provenance",
    scope: "area",
    requires: { all: ["battery/power"] },
  },
};

/** Area-scoped cards an area with `caps` can show (tiles/chart/sankey/amber). Excludes device-scoped. */
export function availableAreaCards(caps: CapabilitySet): CardId[] {
  return (Object.keys(CARD_CATALOG) as CardId[]).filter(
    (id) =>
      CARD_CATALOG[id].scope === "area" &&
      satisfies(caps, CARD_CATALOG[id].requires),
  );
}

/** Device-scoped cards a member device with `caps` can provide (generator-runs/device-metrics/oe-grid). */
export function availableDeviceCards(caps: CapabilitySet): CardId[] {
  return (Object.keys(CARD_CATALOG) as CardId[]).filter(
    (id) =>
      CARD_CATALOG[id].scope === "device" &&
      satisfies(caps, CARD_CATALOG[id].requires),
  );
}
