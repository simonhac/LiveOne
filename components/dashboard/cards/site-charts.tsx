"use client";

/**
 * The collapsed site charts (+ sankey) for a section — the N→1 render unit that the section's
 * `sankey` + stacked-areas `chart` cards merge into (see the collapse pass in Dashboard.tsx and
 * `collapseKey` on those plugins). NOT in the card registry: the host invokes it directly.
 *
 * Self-fetches the handle's `system` (vendorType + timezone) and `latest`, and renders
 * SiteChartsCard for ANY area that has loads + sources — not just mondo/composite "site" vendors.
 * `keys` selects which sub-charts show (chart:load / chart:generation / sankey). The "has loads +
 * sources" decision is data-driven (capability chart eligibility), so a selectronic area with a
 * sankey card renders the sankey here just like a composite would.
 */
import SiteChartsCard from "@/components/SiteChartsCard";
import { capabilitiesFromLatest } from "@/lib/capabilities/derive";
import { satisfies, CARD_CATALOG } from "@/lib/capabilities/catalog";
import { useAreaDatum } from "./shared";

export function SiteChartsGroup({
  systemId,
  keys,
  sankeyOptionsKey,
}: {
  systemId: number;
  keys: Set<string>;
  sankeyOptionsKey?: string;
}) {
  const { datum } = useAreaDatum(systemId);
  const system = datum?.system;
  const latest = datum?.latest ?? {};
  // Hold the layout until `system` (vendorType) is known. Mounting SiteChartsCard with
  // system=undefined disables its history query, which renders "No data available" before any real
  // loading state. An empty min-height container avoids that flash; SiteChartsCard's own (delayed)
  // spinner takes over once the system loads.
  if (!system) {
    return <div className="min-h-[360px]" />;
  }
  // Data-driven (no vendor branch): render the charts/sankey for any area whose data carries sources
  // + loads (== the old `chartHasData`; `system` and `latest` arrive together, so no eager-by-vendor
  // pre-render is needed). The sankey/charts keep their own data gate downstream (two-layer contract).
  const siteCapable = satisfies(
    capabilitiesFromLatest(latest),
    CARD_CATALOG.chart.requires,
  );
  if (!siteCapable) return null;
  return (
    <SiteChartsCard
      systemId={String(systemId)}
      system={system}
      siteCapable={siteCapable}
      cardVisible={(k) => keys.has(k)}
      sankeyOptionsKey={sankeyOptionsKey}
    />
  );
}
