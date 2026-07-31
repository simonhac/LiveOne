/**
 * The NODE CATALOG — the declarative, capability-keyed card ELIGIBILITY data (label + required
 * capabilities + scope), one entry per `KnownCardType`. Server-safe and React-free: the render side
 * is the client plugin registry (components/dashboard/registry.tsx), which replaced the old
 * `card.type` switch in the (since deleted) v3 renderer; the live renderer is
 * components/dashboard/v4/node-view.tsx.
 *
 * ONE CATALOG, ONE VOCABULARY (config-v4 Phase 14 stage 7). `TILE_CATALOG` (8 tiles) and
 * `CARD_CATALOG` (10 cards + the v3 `tiles` container) were separate maps over two id spaces. §8.1
 * unified the primitive — a tile IS a card — so they are now one `Record<KnownCardType, …>` keyed on
 * the same 18-type vocabulary as the render registry and the config schemas
 * (lib/dashboard/card-types.ts). The `tiles` entry is GONE with them: in v4 that container is a `row`
 * group, not a card, so it has no eligibility of its own — its members answer for themselves.
 *
 * Each entry declares the capabilities it REQUIRES. "Which cards can an area show" =
 * `NODE_CATALOG.filter(e => satisfies(scopeCaps(e), e.requires))`. No vendor/device names appear here
 * — a device the presentation layer has never seen lights up the right cards purely via its
 * advertised capabilities.
 *
 * TWO NON-NEGOTIABLE CONTRACTS:
 *  1. **`scope`** — `requires` is checked against the AREA UNION for `scope: "area"` entries, and
 *     against a SPECIFIC MEMBER's capability set for `scope: "device"` entries (`generator-runs`,
 *     `oe-grid`, `device-metrics` bind a member device).
 *  2. **Eligibility ≠ render authority** — this filter is for the Add-Card GALLERY (grey-out) and the
 *     default-dashboard strategy ONLY. It is NEVER the final say on whether a card renders. Renderers
 *     keep their own gate: the sankey still checks `selectFlowMatrix` for *directional* flow (presence
 *     of solar+load is not enough); `oe-grid`/`grid-signals` still resolves a NEM region; every tile
 *     still answers its own `isAvailable`. Do NOT "simplify" a renderer to trust this filter — it will
 *     ship blank/incorrect cards.
 *
 * The gallery filters (`availableAreaCards`/`availableDeviceCards`) remain INERT until an Add-Card
 * UI exists; the renderer reads only `NODE_CATALOG.chart.requires` (the site-charts data gate) and
 * the seed reads `availableTilesFromCaps`. The equivalence test pins that
 * `availableTilesFromCaps ∘ capabilitiesFromLatest` reproduces the legacy `availableTiles` semantics.
 */

import type { CapabilityId } from "@/lib/capabilities/registry";
import type { CapabilitySet } from "@/lib/capabilities/derive";
import type { KnownCardType, TileId } from "@/lib/dashboard/card-types";

export type { TileId };

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

export interface NodeCatalogEntry {
  id: KnownCardType;
  label: string;
  requires: CapReq;
  /** Which capability set `requires` is checked against — the area union, or one member device's. */
  scope: "area" | "device";
  /** For `scope: "device"` entries: the capability the bound member must provide. */
  bindsCapability?: CapabilityId;
}

/**
 * The catalog, in `V4_CARD_TYPES` order (the 9 tile views, then the 9 non-tile card types) — that
 * order is what `availableAreaCards`/`availableDeviceCards` return, so a gallery gets tiles first.
 *
 * `Record<KnownCardType, …>` is the compile gate, the mirror of the render registry's: adding a card
 * type to lib/dashboard/card-types.ts is a build error until it is catalogued here AND has a plugin.
 *
 * Tile requirements are chosen to reproduce `availableTiles(latest)` EXACTLY on the realistic path
 * universe:
 *  - `load` is satisfied by ANY source (the load card synthesises a master load from any source when
 *    no dedicated load point exists) — hence `{ any: [load/power, solar/power, battery/power,
 *    grid/power] }`, mirroring the old `anyLoad || solar || battery || grid` disjunction.
 *
 * `chart`/`sankey` eligibility is `{ all: ["solar/power"] }` — this is EXACTLY `chartHasData(latest)`,
 * which reduces to "has solar" (its `load` disjunct always includes `solar`, so `solar && load ≡
 * solar`). The renderer keeps the real "is there directional flow" gate (`selectFlowMatrix`) — see
 * contract #2 above.
 */
export const NODE_CATALOG: Record<KnownCardType, NodeCatalogEntry> = {
  // --- tile views ------------------------------------------------------------------------------
  // Area-scoped: a tile's eligibility is judged against the area UNION, exactly as the v3
  // `availableTiles(latest)` was. `oe-grid` is the one device-scoped tile — it is bound to an
  // OpenElectricity region device, not derived from an area's capabilities.
  solar: {
    id: "solar",
    label: "Solar",
    scope: "area",
    requires: { all: ["solar/power"] },
  },
  load: {
    id: "load",
    label: "Load",
    scope: "area",
    requires: {
      any: ["load/power", "solar/power", "battery/power", "grid/power"],
    },
  },
  hotWater: {
    id: "hotWater",
    label: "Hot Water",
    scope: "area",
    requires: { all: ["load.hws/temperature"] },
  },
  battery: {
    id: "battery",
    label: "Battery",
    scope: "area",
    requires: { all: ["battery/soc"] },
  },
  "house-to-grid": {
    id: "house-to-grid",
    label: "Grid",
    scope: "area",
    requires: { all: ["grid/power"] },
  },
  amber: {
    id: "amber",
    label: "Amber Price",
    scope: "area",
    requires: { all: ["grid/rate"] },
  },
  ev: {
    id: "ev",
    label: "EV",
    scope: "area",
    requires: { all: ["ev/soc"] },
  },
  // Solar OR grid: a solar site gets all three renewables metrics; a grid-only site still gets the
  // renewable-share metric (metrics 1 & 2 then correctly read 0 / — rather than being hidden).
  // The `renewables` id is historical — the view renders as the "Home Energy" card.
  renewables: {
    id: "renewables",
    label: "Home Energy",
    scope: "area",
    requires: { any: ["solar/power", "grid/power"] },
  },
  "oe-grid": {
    id: "oe-grid",
    label: "Local Grid (NEM)",
    scope: "device",
    requires: { all: ["grid-signals"] },
    bindsCapability: "grid-signals",
  },
  // --- non-tile card types ---------------------------------------------------------------------
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
  // Area-derived provenance cards — gated on a battery being present. Both read engine OUTPUTS (the
  // KV-latest battery points / the ?source=modern flow matrix), not engine internals.
  "battery-contents": {
    id: "battery-contents",
    label: "Battery",
    scope: "area",
    requires: { all: ["battery/power"] },
  },
  "ev-provenance": {
    id: "ev-provenance",
    label: "EV Provenance",
    scope: "area",
    requires: { all: ["battery/power"] },
  },
  "battery-provenance-history": {
    id: "battery-provenance-history",
    label: "Battery History",
    scope: "area",
    requires: { all: ["battery/provenance"] },
  },
  // Deliberately PERMISSIVE. `daily-stripe` paints whatever logical path its config names, so it
  // maps to no single capability — `instrumentation` ("any numeric signal") is the honest floor, and
  // is what keeps the entry satisfiable. Contract #2 above is what makes that safe: the gallery may
  // offer it wherever there is a numeric series, and the plugin still gates on its OWN data (an
  // unresolvable path simply yields an empty map and the card draws background).
  "daily-stripe": {
    id: "daily-stripe",
    label: "Daily Stripes",
    scope: "area",
    requires: { any: ["instrumentation"] },
  },
  // MINIMAL, like `daily-stripe` above and for the same reason: a heatmap paints whichever of the
  // device's points is selected (or pinned), so it maps to no single capability —
  // `instrumentation` ("any numeric signal") is the honest floor and what keeps the entry
  // satisfiable. `scope: "device"` is the difference: unlike `daily-stripe`, the surface enumerates
  // ONE device's point list (`/api/device/{id}/points`), so the gallery must offer it against a
  // member's capability set, not the area union. Contract #2 above still applies — the panel keeps
  // its own data gate (no points ⇒ a "No points" card).
  heatmap: {
    id: "heatmap",
    label: "Heatmap",
    scope: "device",
    requires: { any: ["instrumentation"] },
  },
};

/**
 * Canonical tile order — the order the seed lays small cards out in its `row` group. A strict
 * subset of `NODE_CATALOG` (the 8 capability-derived tiles; `oe-grid` is appended by the seed from
 * its grid-context member, not derived from the area's capabilities).
 */
export const TILE_ORDER: readonly TileId[] = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
  "renewables",
];

/** Which tiles an area/device with `caps` can show, in canonical order — replaces `availableTiles`. */
export function availableTilesFromCaps(caps: CapabilitySet): TileId[] {
  return TILE_ORDER.filter((id) => satisfies(caps, NODE_CATALOG[id].requires));
}

const CATALOG_IDS = Object.keys(NODE_CATALOG) as KnownCardType[];

/** Area-scoped cards an area with `caps` can show (the tiles, chart/sankey/amber, provenance). */
export function availableAreaCards(caps: CapabilitySet): KnownCardType[] {
  return CATALOG_IDS.filter(
    (id) =>
      NODE_CATALOG[id].scope === "area" &&
      satisfies(caps, NODE_CATALOG[id].requires),
  );
}

/** Device-scoped cards a member device with `caps` can provide (generator-runs/device-metrics/oe-grid). */
export function availableDeviceCards(caps: CapabilitySet): KnownCardType[] {
  return CATALOG_IDS.filter(
    (id) =>
      NODE_CATALOG[id].scope === "device" &&
      satisfies(caps, NODE_CATALOG[id].requires),
  );
}
