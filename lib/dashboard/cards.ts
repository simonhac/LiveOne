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
 * power mini-cards (solar/battery/grid/load/amber/ev) are still rendered inside SystemPowerCards;
 * they become first-class descriptor cards in P2.
 */

import type { LatestPointValues } from "@/lib/types/api";
import type { RoleId } from "@/lib/roles/registry";

export type DashboardCardType =
  | "amber"
  | "power-cards"
  | "site-charts"
  | "sankey"
  | "energy-chart"
  | "grid-signals"
  | "generator-runs";

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

/** A "site" system aggregates load/generation series and shows the site charts + Sankey. */
const isSiteVendor = (vt: string) => vt === "mondo" || vt === "composite";

export const CARD_REGISTRY: Record<DashboardCardType, CardDef> = {
  amber: {
    type: "amber",
    label: "Amber Price",
    requiredRoles: ["grid"],
    canRender: (c) => c.vendorType === "amber",
  },
  "power-cards": {
    type: "power-cards",
    label: "Power",
    requiredRoles: ["solar", "battery", "grid", "load"],
    canRender: (c) => c.vendorType !== "amber",
  },
  "site-charts": {
    type: "site-charts",
    label: "Power Charts",
    requiredRoles: ["solar", "load"],
    canRender: (c) => isSiteVendor(c.vendorType),
  },
  sankey: {
    type: "sankey",
    label: "Energy Flows",
    requiredRoles: ["solar", "load"],
    canRender: (c) => isSiteVendor(c.vendorType),
  },
  "energy-chart": {
    type: "energy-chart",
    label: "Energy Chart",
    canRender: (c) => c.vendorType !== "amber" && !isSiteVendor(c.vendorType),
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
};

/** The layout the default dashboard uses for a system (mirrors the vendor_type ladder). */
export function getLayout(vendorType: string): DashboardLayout {
  if (vendorType === "amber") return "amber";
  if (isSiteVendor(vendorType)) return "site";
  return "sidebar";
}

// ============================================================================
// Power mini-cards (P2) — the individually customizable cards inside the
// `power-cards` module. Order/visibility are persisted in the descriptor.
// ============================================================================

export type PowerCardId =
  | "solar"
  | "load"
  | "hotWater"
  | "battery"
  | "grid"
  | "amber"
  | "ev";

/** Default order — matches the historical SystemPowerCards render order (hotWater groups with loads). */
export const POWER_CARD_IDS: readonly PowerCardId[] = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "grid",
  "amber",
  "ev",
];

export interface PowerCardDef {
  id: PowerCardId;
  label: string;
  requiredRoles?: RoleId[];
}

export const POWER_CARDS: Record<PowerCardId, PowerCardDef> = {
  solar: { id: "solar", label: "Solar", requiredRoles: ["solar"] },
  load: { id: "load", label: "Load", requiredRoles: ["load"] },
  hotWater: { id: "hotWater", label: "Hot Water", requiredRoles: ["load"] },
  battery: { id: "battery", label: "Battery", requiredRoles: ["battery"] },
  grid: { id: "grid", label: "Grid", requiredRoles: ["grid"] },
  amber: { id: "amber", label: "Amber Price" },
  ev: { id: "ev", label: "EV" },
};

const hasVal = (latest: LatestPointValues, path: string): boolean =>
  latest[path]?.value != null;

/**
 * Which power mini-cards a system can currently show, given its latest values. Mirrors the
 * point-existence checks inside SystemPowerCards closely enough for the Add-Card gallery to grey
 * out unsupported cards. SystemPowerCards remains the authority for what actually renders.
 */
export function availablePowerCards(latest: LatestPointValues): PowerCardId[] {
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

  const available: Record<PowerCardId, boolean> = {
    solar,
    load,
    // The modelled hot-water temperature is a first-class derived point in `latest`.
    hotWater: hasVal(latest, "load.hws/temperature"),
    battery: hasVal(latest, "bidi.battery/soc"),
    grid: hasVal(latest, "bidi.grid/power"),
    amber: hasVal(latest, "bidi.grid.import/rate"),
    ev: hasVal(latest, "ev.battery/soc"),
  };
  return POWER_CARD_IDS.filter((id) => available[id]);
}
