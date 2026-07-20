"use client";

/**
 * The collapsed site charts (+ sankey) for a section — the N→1 render unit that the section's
 * `sankey` + stacked-areas `chart` cards merge into (see the collapse pass in Dashboard.tsx and
 * `collapseKey` on those plugins). NOT in the card registry: the host invokes it directly.
 *
 * Renders SiteChartsCard for ANY area that has loads + sources — not just mondo/composite "site"
 * vendors. `keys` selects which sub-charts show (chart:load / chart:generation / sankey). Eligibility
 * (`chartCapable`) is CONFIG-derived server-side (`hasChartCapability`, threaded through the Area
 * lookup — see `lib/areas/list.ts`'s `withChartCapability`) and passed in as a prop, so this can fire
 * SiteChartsCard's history/sankey fetch immediately instead of waiting on `/api/data`'s live `latest`
 * map to run the client-side capability check. `system` (vendorType/tz) still comes from the shared
 * `useAreaDatum` cache for display — SiteChartsCard tolerates it being unresolved yet (tz-dependent
 * bits fall back/blank until it lands).
 */
import SiteChartsCard from "@/components/SiteChartsCard";
import { useAreaDatum } from "./shared";

export function SiteChartsGroup({
  systemId,
  keys,
  sankeyOptionsKey,
  chartCapable,
}: {
  systemId: number;
  keys: Set<string>;
  sankeyOptionsKey?: string;
  /** CONFIG-derived chart/sankey eligibility from the Area lookup — undefined while that's still
   *  resolving (treated as not-yet-capable; re-renders once it lands). */
  chartCapable?: boolean;
}) {
  const { datum } = useAreaDatum(systemId);
  const system = datum?.system;
  if (!chartCapable) return null;
  return (
    <SiteChartsCard
      systemId={String(systemId)}
      system={system}
      siteCapable={chartCapable}
      cardVisible={(k) => keys.has(k)}
      sankeyOptionsKey={sankeyOptionsKey}
    />
  );
}
