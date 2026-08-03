/**
 * The TILE half of the node plugin contract — one plugin per `TileView` (the 8 standard tiles +
 * `oe-grid`), registered alongside the card plugins in the single `CARD_RENDERERS`
 * (components/dashboard/registry.tsx).
 *
 * A tile plugin is a self-contained module: a pure availability predicate (replacing the old
 * `useTileNodes` `available` map) plus a Render component that owns any tile-specific hooks
 * (e.g. the hot-water sparkline query). The host (`node-view.tsx`'s V4TileCell) fetches the
 * device's `dashboardDataQuery` datum, gates mount on `isAvailable`, and passes these props.
 *
 * WHY THIS IS STILL ITS OWN CONTRACT (config-v4 Phase 14 stage 7). §8.1 unified the card and tile
 * *document* primitives — a tile is just a small card, and one registry now answers for both. It did
 * NOT unify the two RENDER contracts, which differ in substance rather than spelling: a tile is
 * DATA-DRIVEN (the host self-fetches `/api/data` in `V4TileCell` and hands the plugin a `latest` map,
 * from which the plugin also answers `isAvailable`), where a card is DOCUMENT-DRIVEN (it is handed
 * the `CardNode` + inherited `NodeContext` and fetches whatever it needs itself). Collapsing them
 * would mean either fetching `/api/data` for every card node or giving every tile props it ignores.
 * So the registry holds a DISCRIMINATED UNION (`kind`), not a lowest-common-denominator prop bag.
 */
import type React from "react";
import type { TileView } from "@/lib/dashboard/card-types";
import type { LatestPointValues } from "@/lib/types/api";

export interface TileRenderProps {
  /** The tile's device's latest point values (from `dashboardDataQuery`). */
  latest: LatestPointValues;
  /** The raw `dashboardDataQuery` payload — `oe-grid` reads `device.vendorSiteId` for its region. */
  data: unknown;
  /** Omitted by prop-driven hosts (the labs card gallery): disables the HWS fetch / Tesla cog. */
  systemId?: number;
  staleThresholdSeconds: number;
  /** Gates the `house-to-grid` tile (the dashboard passes `!!latest["bidi.grid/power"]`). */
  showGrid: boolean;
  canControl: boolean;
}

export interface TilePlugin {
  /** The registry's discriminant: `node-view.tsx` dispatches on this after ONE lookup. */
  kind: "tile";
  type: TileView;
  /**
   * Pure availability predicate — the authoritative "does this tile have data". The host mounts
   * Render only when true (an unavailable tile renders nothing, as before).
   */
  isAvailable(
    props: Pick<TileRenderProps, "latest" | "data" | "showGrid">,
  ): boolean;
  /**
   * The logical paths of the points this tile's controls would COMMAND, most specific first.
   *
   * 🛑 Declaring them is what lets the host gate the control on ownership of the device that would
   * actually be commanded, rather than on the subject the tile happened to FETCH under — an EV tile
   * inside a multi-device area fetches the AREA, and the area's owner need not own the car. Omit it
   * and the tile's `canControl` falls back to the subject-level flag (correct for every tile that
   * renders no control at all).
   */
  controlPaths?: readonly string[];
  /**
   * Extra classes for this tile's loading placeholder, when the tile does not have the standard
   * `Tile` box model. The tile grid is `auto-rows-fr`, so a placeholder that measures differently
   * from the tile it stands in for resizes the ENTIRE row when the swap happens — the two
   * container-query tiles (`amber`, `ev`) step up at `@[180px]` and must say so. Omit for a plain
   * `Tile`; see `TileSkeleton` in ../cards/shared.tsx for the default.
   */
  skeletonClass?: string;
  Render: React.FC<TileRenderProps>;
}
