/**
 * Dashboard card registry — the declarative catalog of dashboard modules ("cards").
 *
 * This is the data that replaces the implicit `vendor_type` if/else ladder in
 * components/DashboardClient.tsx: `buildDefaultDescriptor()` (lib/dashboard/descriptor.ts) reads a
 * system and emits the same cards + layout the ladder produces today. Each card declares a
 * `canRender` predicate so the planned Add-Card gallery (P2) can grey out cards a system can't
 * satisfy. See docs/architecture/areas-and-dashboards.md.
 *
 * P1 models cards at the MODULE level — the granularity the ladder actually chooses. The individual
 * tiles (solar/battery/grid/load/amber/ev) are still rendered inside SystemTiles;
 * they become first-class descriptor cards in P2.
 */

import type { LatestPointValues } from "@/lib/types/api";
import type { RoleId } from "@/lib/roles/registry";

export type DashboardCardType =
  | "amber-now"
  | "amber-timeline"
  | "tiles"
  | "chart"
  | "sankey"
  | "grid-signals"
  | "generator-runs"
  | "device-metrics";

export type DashboardLayout = "amber" | "site" | "sidebar";

export interface CardContext {
  vendorType: string;
  latest: LatestPointValues;
  /** Whether the system has an enabled generator run-tracker (run-tracking feature). */
  hasGenerator?: boolean;
}

export interface CardDef {
  type: DashboardCardType;
  label: string;
  /** Roles whose presence makes this card meaningful (used by the P2 Add-Card gallery). */
  requiredRoles?: RoleId[];
  /** Whether the card is eligible to render in this context (mirrors today's vendor_type ladder). */
  canRender: (ctx: CardContext) => boolean;
}

/** A "site" view aggregates load/generation series and shows the site charts + Sankey: the mondo site
 *  vendor, or a multi-device Area view (synthesized vendorType "area"). */
const isSiteVendor = (vt: string) => vt === "mondo" || vt === "area";

export const CARD_REGISTRY: Record<DashboardCardType, CardDef> = {
  "amber-now": {
    type: "amber-now",
    label: "Amber Price",
    requiredRoles: ["grid"],
    // Data-driven (not vendor-driven): the live Amber price card is meaningful wherever the import
    // rate point exists. The default amber layout still selects it via getLayout; this is the
    // gallery-eligibility hint.
    canRender: (c) => hasVal(c.latest, "bidi.grid.import/rate"),
  },
  "amber-timeline": {
    type: "amber-timeline",
    label: "Amber Forecast",
    requiredRoles: ["grid"],
    canRender: (c) => hasVal(c.latest, "bidi.grid.import/rate"),
  },
  tiles: {
    type: "tiles",
    label: "Tiles",
    requiredRoles: ["solar", "battery", "grid", "load"],
    canRender: (c) => c.vendorType !== "amber",
  },
  chart: {
    type: "chart",
    label: "Power Chart",
    requiredRoles: ["solar", "load"],
    // Data-driven, NOT vendor-driven (the whole point of the generalized chart card): eligible on any
    // system with chartable series — true for both site (mondo/composite) and sidebar
    // (selectronic/enphase) systems, false only for data-less / pure-amber.
    canRender: (c) => chartHasData(c.latest),
  },
  sankey: {
    type: "sankey",
    label: "Energy Flows",
    requiredRoles: ["solar", "load"],
    // Data-driven, NOT vendor-driven: the energy-flow matrix is keyed on logical paths, so a sankey
    // renders for ANY area with sources + loads (single selectronic, multi-device composite, …), not
    // just the mondo/composite "site" layout. Same bar as the chart card.
    canRender: (c) => chartHasData(c.latest),
  },
  "grid-signals": {
    type: "grid-signals",
    label: "Local Grid (NEM)",
    requiredRoles: ["grid"],
    // Eligibility approximates the off-grid rule (a grid-connected system has a grid point). The
    // AUTHORITATIVE gate is server-side `resolveGridContextForSystem` (lib/grid/context.ts), which
    // also needs the Area's location to derive a region + a seeded OE system — things canRender
    // can't see. Treat this only as a gallery-eligibility hint, not the final say.
    canRender: (c) =>
      c.vendorType !== "amber" && hasVal(c.latest, "bidi.grid/power"),
  },
  "generator-runs": {
    type: "generator-runs",
    label: "Generator Runs",
    requiredRoles: ["generator"],
    // Eligible only where the system has an enabled generator run-tracker.
    canRender: (c) => !!c.hasGenerator,
  },
  "device-metrics": {
    type: "device-metrics",
    label: "Device Metrics",
    // NO requiredRoles — the whole point of this card is to surface a device's raw instrumentation
    // points (voltage/rpm/temperature/…) straight from point_info, with no energy-flow role. Loose,
    // data-driven gallery hint: any non-amber device with at least one numeric reading. Auto-inclusion
    // on the device viewer is separately gated in buildDefaultDashboardV3 (tile-less devices only).
    canRender: (c) => c.vendorType !== "amber" && hasAnyNumeric(c.latest),
  },
};

/** The layout the default dashboard uses for a system (mirrors the vendor_type ladder). */
export function getLayout(vendorType: string): DashboardLayout {
  if (vendorType === "amber") return "amber";
  if (isSiteVendor(vendorType)) return "site";
  return "sidebar";
}

// ============================================================================
// Tiles (P2) — the individually customizable cards inside the
// `tiles` module. Order/visibility are persisted in the descriptor.
// ============================================================================

export type TileId =
  | "solar"
  | "load"
  | "hotWater"
  | "battery"
  | "house-to-grid"
  | "amber"
  | "ev";

/** Default order — matches the historical SystemTiles render order (hotWater groups with loads). */
export const TILE_IDS: readonly TileId[] = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
];

export interface TileDef {
  id: TileId;
  label: string;
  requiredRoles?: RoleId[];
}

export const TILES: Record<TileId, TileDef> = {
  solar: { id: "solar", label: "Solar", requiredRoles: ["solar"] },
  load: { id: "load", label: "Load", requiredRoles: ["load"] },
  hotWater: { id: "hotWater", label: "Hot Water", requiredRoles: ["load"] },
  battery: { id: "battery", label: "Battery", requiredRoles: ["battery"] },
  "house-to-grid": {
    id: "house-to-grid",
    label: "Grid",
    requiredRoles: ["grid"],
  },
  amber: { id: "amber", label: "Amber Price" },
  ev: { id: "ev", label: "EV" },
};

const hasVal = (latest: LatestPointValues, path: string): boolean =>
  latest[path]?.value != null;

/** Whether the system has any numeric latest value (gates the role-free device-metrics card). */
const hasAnyNumeric = (latest: LatestPointValues): boolean =>
  Object.values(latest).some((v) => typeof v?.value === "number");

/**
 * Whether a system has enough series to draw a chart (either variant): solar AND a load signal,
 * using the same point paths as `availableTiles`. Gates the vendor-independent `chart` card.
 */
export function chartHasData(latest: LatestPointValues): boolean {
  const solar =
    hasVal(latest, "source.solar/power") ||
    hasVal(latest, "source.solar.local/power") ||
    hasVal(latest, "source.solar.remote/power");
  const load =
    hasVal(latest, "load/power") ||
    Object.keys(latest).some(
      (p) => p.startsWith("load.") && p.endsWith("/power") && hasVal(latest, p),
    ) ||
    solar ||
    hasVal(latest, "bidi.battery/power") ||
    hasVal(latest, "bidi.grid/power");
  return solar && load;
}

/**
 * Which tiles a system can currently show, given its latest values. Mirrors the
 * point-existence checks inside SystemTiles closely enough for the Add-Card gallery to grey
 * out unsupported cards. SystemTiles remains the authority for what actually renders.
 */
export function availableTiles(latest: LatestPointValues): TileId[] {
  const solar =
    hasVal(latest, "source.solar/power") ||
    hasVal(latest, "source.solar.local/power") ||
    hasVal(latest, "source.solar.remote/power");
  const anyLoad =
    hasVal(latest, "load/power") ||
    Object.keys(latest).some(
      (p) => p.startsWith("load.") && p.endsWith("/power") && hasVal(latest, p),
    );
  // The load card synthesises a master from any source when no load point exists.
  const load =
    anyLoad ||
    solar ||
    hasVal(latest, "bidi.battery/power") ||
    hasVal(latest, "bidi.grid/power");

  const available: Record<TileId, boolean> = {
    solar,
    load,
    // The modelled hot-water temperature is a first-class derived point in `latest`.
    hotWater: hasVal(latest, "load.hws/temperature"),
    battery: hasVal(latest, "bidi.battery/soc"),
    "house-to-grid": hasVal(latest, "bidi.grid/power"),
    amber: hasVal(latest, "bidi.grid.import/rate"),
    ev: hasVal(latest, "ev.battery/soc"),
  };
  return TILE_IDS.filter((id) => available[id]);
}
