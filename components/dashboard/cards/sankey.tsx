"use client";

/**
 * The `sankey` card — always a member of the site-charts collapse (see ./site-charts.tsx), so it
 * never renders standalone; the Render below is unreachable and exists only to keep the registry's
 * exhaustiveness check total.
 */
import type { CardPlugin } from "./types";
import { siteChartsFootprint } from "./footprints";

export const sankeyPlugin: CardPlugin = {
  kind: "card",
  type: "sankey",
  // Unreachable in practice for the same reason `Render` is — the collapse always claims this node,
  // and the GROUP reserves the block's height via `siteChartsFootprint`. Declared consistently
  // anyway so the number can never be two different things.
  footprint: () => siteChartsFootprint(["sankey"]),
  collapseKey: () => "sankey",
  Render: () => null,
};
