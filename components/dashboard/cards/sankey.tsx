"use client";

/**
 * The `sankey` card — always a member of the site-charts collapse (see ./site-charts.tsx), so it
 * never renders standalone; the Render below is unreachable and exists only to keep the registry's
 * exhaustiveness check total.
 */
import type { CardPlugin } from "./types";

export const sankeyPlugin: CardPlugin = {
  type: "sankey",
  collapseKey: () => "sankey",
  Render: () => null,
};
