/**
 * Dashboard CARD type vocabulary — the v3 `DashboardCardType` union used by the v3 descriptor (v3.ts)
 * and the capability catalog (lib/capabilities/catalog.ts).
 *
 * `DashboardLayout` went with `AreaSectionV3.layout` (config-v4 Phase 14 stage 8): the override seam
 * had zero readers and zero writers, so the type had no consumer either.
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
