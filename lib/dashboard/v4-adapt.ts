/**
 * config-v4 dashboard renderer — the pure v4-node → v3-plugin-props adapter (Phase 5, DARK).
 *
 * The v4 renderer (node-view.tsx) reuses the UNCHANGED v3 card/tile plugin components rather than
 * rewriting all ~19 of them: a v4 `card` node is adapted to the `CardV3`/`AreaSectionV3` shape the v3
 * `CardPlugin.Render` expects, or to the `(view, systemId)` a tile cell expects. The two v3 registries
 * stay as-is; the full "merge into one registry + delete v3" happens at cutover when v3 dies.
 *
 * This module is PURE (no React) so the mapping is unit-testable. The React wiring + the SiteChartsGroup
 * collapse (which reuses each v3 plugin's own `collapseKey`) live in node-view.tsx.
 */
import type { CardNode } from "@/lib/dashboard/v4";
import type {
  CardV3,
  AreaSectionV3,
  ChartCardConfig,
  TileView,
  DashboardCardType,
} from "@/lib/dashboard/v3";
import { isKnownCardType } from "@/lib/dashboard/card-types";

/** The 9 promoted tile views — v4 card types that render via a tile cell (not a v3 CardPlugin). */
export const TILE_VIEW_TYPES: ReadonlySet<string> = new Set<TileView>([
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
  "renewables",
  "oe-grid",
]);

export function isTileViewType(type: string): type is TileView {
  return TILE_VIEW_TYPES.has(type);
}

/** A v4 card type that maps to a v3 `CardPlugin` (everything known that isn't a tile view or `tiles`). */
export function isV3CardType(type: string): type is DashboardCardType {
  return isKnownCardType(type) && !isTileViewType(type);
}

/** Closed renderer dispatch. `unknown` is the labelled-placeholder branch, never a plugin lookup. */
export function v4CardRenderKind(type: string): "tile" | "v3" | "unknown" {
  if (isTileViewType(type)) return "tile";
  if (isV3CardType(type)) return "v3";
  return "unknown";
}

/**
 * Build the `CardV3` a v3 `CardPlugin.Render` reads, from a v4 card node + its resolved device handle.
 * `deviceSystemId` is the legacy `system_id` the device ref resolved to (device-bound cards read it;
 * omit ⇒ the plugin falls back to the section handle).
 */
export function synthCardV3(node: CardNode, deviceSystemId?: number): CardV3 {
  const card: CardV3 = { type: node.type as DashboardCardType };
  if (node.id) card.id = node.id;
  if (node.hidden) card.hidden = true;
  if (deviceSystemId != null) card.deviceSystemId = deviceSystemId;
  if (node.type === "chart" && node.config) {
    card.chart = node.config as ChartCardConfig;
  }
  if (
    node.type === "device-metrics" &&
    node.config &&
    typeof node.config === "object"
  ) {
    const variant = (node.config as { variant?: "grid" | "table" }).variant;
    if (variant) card.variant = variant;
  }
  return card;
}

/**
 * Build the `AreaSectionV3` a v3 `CardPlugin.Render` reads. The plugins consume `section.areaId`
 * (the area uuid — e.g. battery-provenance-history keys on it); `cards` is unused by the render path,
 * so an empty list suffices. `areaUuid` is the decoded `context.area` (via `Area.toUuid`).
 */
export function synthSectionV3(areaUuid: string | undefined): AreaSectionV3 {
  return { areaId: areaUuid ?? "", cards: [] };
}
