/**
 * Dashboard CARD type vocabulary — the v3 `DashboardCardType`/`DashboardLayout` unions used by the v3
 * descriptor (v3.ts) and the capability catalog (lib/capabilities/catalog.ts).
 *
 * The TILE vocabulary (`TileView`/`TileId`) moved to lib/dashboard/card-types.ts, which owns the
 * unified v4 card types — the tile plugins and the capability catalog read it from there.
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
  | "device-metrics"
  | "battery-contents"
  | "ev-provenance"
  | "battery-provenance-history";

/** Layout hint (derived, never stored) — retained for the optional AreaSectionV3.layout override seam. */
export type DashboardLayout = "amber" | "site" | "sidebar";
