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
  | "energy-chart";

export type DashboardLayout = "amber" | "site" | "sidebar";

export interface CardContext {
  vendorType: string;
  latest: LatestPointValues;
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
};

/** The layout the default dashboard uses for a system (mirrors the vendor_type ladder). */
export function getLayout(vendorType: string): DashboardLayout {
  if (vendorType === "amber") return "amber";
  if (isSiteVendor(vendorType)) return "site";
  return "sidebar";
}
