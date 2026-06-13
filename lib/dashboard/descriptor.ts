/**
 * Dashboard descriptor — the ordered set of cards + layout that drives DashboardClient.
 *
 * `buildDefaultDescriptor()` generates the descriptor on the fly from a system, reproducing the
 * vendor_type if/else ladder exactly so the descriptor-driven render is identical to today's. In
 * P2 a user's saved descriptor (forked from this default) is loaded instead. See
 * docs/architecture/areas-and-dashboards.md.
 */

import type { LatestPointValues } from "@/lib/types/api";
import {
  getLayout,
  type DashboardCardType,
  type DashboardLayout,
} from "./cards";

export interface DashboardCardInstance {
  type: DashboardCardType;
}

export interface DashboardDescriptor {
  layout: DashboardLayout;
  cards: DashboardCardInstance[];
}

/** Cards each layout shows by default — the exact set the vendor_type ladder renders today. */
const CARDS_BY_LAYOUT: Record<DashboardLayout, DashboardCardType[]> = {
  amber: ["amber"],
  site: ["power-cards", "site-charts", "sankey"],
  sidebar: ["power-cards", "energy-chart"],
};

/**
 * Generate the default dashboard descriptor for a system. Layout and card set depend only on the
 * vendor type (as the ladder does today); `latest` is accepted for forward-compatibility with the
 * P2 per-card eligibility pass but is not used here.
 */
export function buildDefaultDescriptor(
  system: { vendorType: string },
  _latest: LatestPointValues,
): DashboardDescriptor {
  const layout = getLayout(system.vendorType);
  return {
    layout,
    cards: CARDS_BY_LAYOUT[layout].map((type) => ({ type })),
  };
}
