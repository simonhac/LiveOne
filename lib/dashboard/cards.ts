/**
 * Dashboard card + tile TYPE vocabulary — the shared string unions used across the descriptor (v3.ts),
 * the capability catalog (lib/capabilities/catalog.ts), and the tile renderer.
 *
 * The former card/tile REGISTRIES and the vendor-keyed derivers (CARD_REGISTRY, TILES, getLayout,
 * isSiteVendor, availableTiles, chartHasData) were removed at the P5 cleanup: card/layout selection is
 * now capability-driven (lib/capabilities/*), not a vendor_type ladder. This file is just the type home.
 */

export type DashboardCardType =
  | "amber-now"
  | "amber-timeline"
  | "tiles"
  | "chart"
  | "sankey"
  | "generator-runs"
  | "device-metrics";

/** Layout hint (derived, never stored) — retained for the optional AreaSectionV3.layout override seam. */
export type DashboardLayout = "amber" | "site" | "sidebar";

export type TileId =
  | "solar"
  | "load"
  | "hotWater"
  | "battery"
  | "house-to-grid"
  | "amber"
  | "ev";
