/**
 * The tile plugin contract — one plugin per `TileView` (the 7 standard tiles + `oe-grid`).
 *
 * A tile plugin is a self-contained module: a pure availability predicate (replacing the old
 * `useTileNodes` `available` map) plus a Render component that owns any tile-specific hooks
 * (e.g. the hot-water sparkline query). The host (`tiles-card.tsx` TileCell) fetches the
 * system's `dashboardDataQuery` datum, gates mount on `isAvailable`, and passes these props.
 */
import type React from "react";
import type { TileView } from "@/lib/dashboard/v3";
import type { LatestPointValues } from "@/lib/types/api";

export interface TileRenderProps {
  /** The tile's system's latest point values (from `dashboardDataQuery`). */
  latest: LatestPointValues;
  /** The raw `dashboardDataQuery` payload — `oe-grid` reads `system.vendorSiteId` for its region. */
  data: unknown;
  /** Omitted by prop-driven hosts (the labs card gallery): disables the HWS fetch / Tesla cog. */
  systemId?: number;
  staleThresholdSeconds: number;
  /** Gates the `house-to-grid` tile (the dashboard passes `!!latest["bidi.grid/power"]`). */
  showGrid: boolean;
  canControl: boolean;
}

export interface TilePlugin {
  view: TileView;
  /**
   * Pure availability predicate — the authoritative "does this tile have data". The host mounts
   * Render only when true (an unavailable tile renders nothing, as before).
   */
  isAvailable(
    props: Pick<TileRenderProps, "latest" | "data" | "showGrid">,
  ): boolean;
  Render: React.FC<TileRenderProps>;
}
