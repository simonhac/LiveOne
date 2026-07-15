/**
 * The card plugin contract — one plugin per `DashboardCardType`, registered in ./registry.tsx.
 *
 * A card plugin bundles the render component (ex-`AreaXxx` wrapper from Dashboard.tsx) with the
 * host-facing render policy: how it behaves while the section's Area handle is unresolved
 * (`pending`) and whether it collapses into the section's single SiteChartsGroup (`collapseKey`).
 * The declarative catalog data (label, capability requirements, scope) stays server-safe in
 * `lib/capabilities/catalog.ts` — this layer is client-only render binding.
 */
import type React from "react";
import type {
  AreaSectionV3,
  CardV3,
  DashboardCardType,
} from "@/lib/dashboard/v3";

export interface CardRenderProps {
  card: CardV3;
  /** The card's section — battery-provenance-history reads its areaId / `device-` sentinel. */
  section: AreaSectionV3;
  /** The Area's handle (area.legacySystemId). Defined for `pending: "host-skeleton"` plugins
   *  (the host gates on it); may be undefined for `pending: "self"` plugins. */
  handle?: number;
}

export interface CardPlugin {
  type: DashboardCardType;
  /**
   * Unresolved-handle behavior:
   *  - "host-skeleton" (default): the host renders <ChartSkeleton/> until the handle resolves,
   *    then mounts Render with a defined handle. (All chart-ish cards.)
   *  - "self": Render always mounts and handles handle === undefined itself (the tiles card
   *    draws its own per-cell skeletons).
   */
  pending?: "host-skeleton" | "self";
  /**
   * Site-charts collapse membership. Non-null ⇒ this card does NOT render standalone; it
   * contributes the returned key ("sankey" | "chart:load" | "chart:generation") to the section's
   * single SiteChartsGroup (see ./site-charts.tsx). sankey: () => "sankey"; chart: stacked-areas
   * variant only, null for lines.
   */
  collapseKey?: (card: CardV3) => string | null;
  Render: React.FC<CardRenderProps>;
}
