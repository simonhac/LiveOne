"use client";

import { Battery } from "lucide-react";
import Stat from "@/components/ui/stat";
import StatCardShell from "@/components/ui/stat-card-shell";
import { formatCarbonTotal } from "@/lib/provenance-format";
import type { BatteryContentsValues } from "@/lib/battery/contents-latest";

export interface BatteryContentsCardProps {
  values: BatteryContentsValues | null;
  title?: string;
  staleThresholdSeconds?: number;
}

/** ±$ from signed cents. */
function dollars(cents: number): string {
  return `${cents < 0 ? "−" : ""}$${Math.abs(cents / 100).toFixed(2)}`;
}
/** ±c from signed cents/kWh. */
function cents(c: number): string {
  return `${c < 0 ? "−" : ""}${Math.abs(c).toFixed(1)}`;
}

/**
 * Presentational "Battery Contents" card — the INVENTORY VALUATION of the energy currently in the battery:
 * usable kWh, total carbon + intensity, total cost split into actual (out-of-pocket) + opportunity (forgone
 * export), renewable proportion, and the value of the contents at the current feed-in rate (only when an
 * export tariff exists). Supersedes BatteryBlendCard (which showed only the per-kWh intensities). No data
 * fetching here — the typed `values` prop comes from `batteryContentsFromData` over a `dashboardDataQuery`
 * payload; the absolute totals are `intensity × stored-energy`, reconstructed exactly.
 *
 * Layout/staleness come from the shared {@link StatCardShell}: an `@container` grid of labelled stats that
 * reflows by the card's OWN width; when stale the card dims and a Clock tooltip shows the last update. The
 * absolute totals degrade to "—" during warm-up (no `stored-energy` point yet); the export stat is hidden
 * without a tariff; an empty battery reads "0.0 kWh" with em-dashes elsewhere.
 */
export default function BatteryContentsCard({
  values,
  title = "Battery",
  staleThresholdSeconds = 900,
}: BatteryContentsCardProps) {
  if (values === null) return null;

  const {
    storedEnergyKwh,
    carbonIntensity,
    renewableFraction,
    priceActual,
    priceOpportunity,
    totalCarbonG,
    totalCostActualC,
    totalCostOpportunityC,
    exportRate,
    exportValueC,
  } = values;

  // Forgone feed-in (opportunity) revenue is ≥ 0; surface it only once it rounds to > $0.
  const showForgone =
    totalCostOpportunityC != null && Math.round(totalCostOpportunityC) > 0;
  const hasExport = exportRate != null && exportValueC != null;
  const renewableGreen = renewableFraction != null && renewableFraction > 50;

  // Total emissions for the secondary line: kg above 1 kg, else grams.
  const carbonTotalText =
    totalCarbonG == null ? null : formatCarbonTotal(totalCarbonG);

  const hasSecondary =
    totalCostActualC != null ||
    carbonTotalText != null ||
    hasExport ||
    showForgone;

  return (
    <StatCardShell
      icon={<Battery size={16} />}
      title={title}
      measurementTime={
        values.measurementTime != null
          ? new Date(values.measurementTime)
          : undefined
      }
      staleThresholdSeconds={staleThresholdSeconds}
    >
      {/* Headline: usable kWh · ¢/kWh · g/kWh · renewable — the unit economics of
          the stored energy. The per-kWh denominator rides in the UNIT (`classifyUnit`
          mutes the `/kWh` tail), so the caption stays a single word. 2 → 3 → 4
          columns as the card widens. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 @[360px]:grid-cols-3 @[520px]:grid-cols-4">
        <Stat
          value={storedEnergyKwh != null ? storedEnergyKwh.toFixed(1) : "—"}
          unit={storedEnergyKwh != null ? "kWh" : undefined}
          caption="usable"
        />
        <Stat
          value={priceActual != null ? cents(priceActual) : "—"}
          unit={priceActual != null ? "¢/kWh" : undefined}
          caption="rate"
        />
        <Stat
          value={
            carbonIntensity != null ? `${Math.round(carbonIntensity)}` : "—"
          }
          unit={carbonIntensity != null ? "g/kWh" : undefined}
          caption="emissions"
        />
        <Stat
          value={
            renewableFraction != null ? `${Math.round(renewableFraction)}` : "—"
          }
          unit={renewableFraction != null ? "%" : undefined}
          caption="renewable"
          valueClassName={renewableGreen ? "text-green-400" : undefined}
        />
      </div>

      {/* Secondary: the absolute totals — financial (out-of-pocket) cost, total
          emissions, export value, and the forgone feed-in revenue (when > $0). */}
      {hasSecondary && (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-gray-700/60 pt-2 text-[11px] text-gray-400">
          {totalCostActualC != null && (
            <span>{dollars(totalCostActualC)} financial cost</span>
          )}
          {carbonTotalText != null && <span>{carbonTotalText} CO₂</span>}
          {hasExport && <span>{dollars(exportValueC!)} export value</span>}
          {showForgone && (
            <span className="ml-auto text-amber-300">
              {dollars(totalCostOpportunityC!)} forgone FiT
              {priceOpportunity != null && ` · ${cents(priceOpportunity)}¢/kWh`}
            </span>
          )}
        </div>
      )}
    </StatCardShell>
  );
}
