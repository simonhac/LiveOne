"use client";

import { Leaf } from "lucide-react";
import Stat from "@/components/ui/stat";
import Value from "@/components/ui/value";
import StatCardShell from "@/components/ui/stat-card-shell";
import type { RenewablesSummary } from "@/lib/renewables/summary";
import {
  formatCarbonTotal,
  formatCentsPerKwh,
  formatDollars,
  formatGramsPerKwh,
  formatKwh,
  formatRenewablePctBare,
} from "@/lib/provenance-format";

export interface HomeEnergyCardProps {
  summary: RenewablesSummary | null;
  /** The navigator period, spelled out — "24 hours" / "7 days" / "30 days" / "12 months". */
  periodLabel: string;
  measurementTime?: Date;
  staleThresholdSeconds?: number;
  loading?: boolean;
}

const AUTARKY_TIP =
  "Renewable autarky — the share of your consumption covered by your OWN renewable generation " +
  "(solar directly, or via the battery at its self-renewable blend). Grid imports and any backup " +
  "generator are self-origin only when renewable, so grid mix and generator energy are excluded here.";
const SELF_CONSUMPTION_TIP =
  "Own-renewable self-consumption — of the renewable energy you generated, the fraction consumed on " +
  "site rather than exported. Battery round-trip losses reduce it. “—” when you generated no own " +
  "renewable in the period.";
const SHARE_TIP =
  "Renewable share of consumption — your own renewables plus the renewable fraction of the grid you " +
  "imported.";
const RATE_TIP =
  "Out-of-pocket cost of the energy you consumed, per kWh. Self-consumed solar is free, so this is " +
  "not a bill: export revenue is counted elsewhere and forgone feed-in isn't counted at all.";

/**
 * The "Home Energy" card — what the whole site CONSUMED over the dashboard's selected period: energy,
 * the blended rate and emissions intensity it came at, and how renewable it was; then the absolute
 * totals and the two own-generation ratios beneath a divider.
 *
 * The same shape as {@link BatteryContentsCard} (shared {@link StatCardShell} + `Stat` grid) because it
 * answers the same question one level up: that card values the energy sitting in the battery, this one
 * values the energy the house actually used. Purely presentational — the caller reduces
 * {@link RenewablesSummary} client-side from the attributed-flow payload the Sankey already fetched.
 *
 * The renewable stat is `metrics.renewableShare` (denominator = total consumption), the same number the
 * "Renewable" row used to show, so it can't disagree with the Autarky/Self-use rows below it. The rate
 * and emissions intensity use FILTERED denominators (known-intensity energy only) — see the reducer.
 */
export default function HomeEnergyCard({
  summary,
  periodLabel,
  measurementTime,
  staleThresholdSeconds,
  loading = false,
}: HomeEnergyCardProps) {
  const shell = (children: React.ReactNode) => (
    <StatCardShell
      icon={<Leaf size={16} />}
      title="Home Energy"
      titleSuffix={periodLabel}
      measurementTime={measurementTime}
      staleThresholdSeconds={staleThresholdSeconds}
    >
      {children}
    </StatCardShell>
  );

  if (loading) {
    return shell(
      <div className="h-16 animate-pulse rounded bg-gray-700/40" aria-hidden />,
    );
  }
  if (!summary || summary.consumptionKwh <= 0) {
    return shell(
      <p className="py-3 text-sm text-gray-500">
        No attributed energy for this period yet.
      </p>,
    );
  }

  const { metrics } = summary;
  const renewablePct =
    metrics.renewableShare != null ? 100 * metrics.renewableShare : null;
  const renewableGreen = renewablePct != null && renewablePct > 50;

  return shell(
    <>
      {/* Headline: consumed kWh · ¢/kWh · g/kWh · renewable — the unit economics of
          everything the house used this period. 2 → 3 → 4 columns as the card widens. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 @[360px]:grid-cols-3 @[520px]:grid-cols-4">
        <Stat
          value={formatKwh(summary.consumptionKwh)}
          unit="kWh"
          caption="consumed"
        />
        <Stat
          value={formatCentsPerKwh(summary.avgCentsPerKwh)}
          unit={summary.avgCentsPerKwh != null ? "¢/kWh" : undefined}
          caption={<span title={RATE_TIP}>rate</span>}
        />
        <Stat
          value={formatGramsPerKwh(summary.avgGramsPerKwh)}
          unit={summary.avgGramsPerKwh != null ? "g/kWh" : undefined}
          caption="emissions"
        />
        <Stat
          value={formatRenewablePctBare(renewablePct)}
          unit={renewablePct != null ? "%" : undefined}
          caption={<span title={SHARE_TIP}>renewable</span>}
          valueClassName={renewableGreen ? "text-green-400" : undefined}
        />
      </div>

      {/* Secondary: the absolute totals, then the two own-generation ratios. */}
      <div className="mt-3 border-t border-gray-700/60 pt-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-gray-400">
          <span>{formatDollars(summary.costC)} financial cost</span>
          <span>{formatCarbonTotal(summary.emissionsG)} CO₂</span>
        </div>
        <div className="mt-2 space-y-0.5 text-xs">
          <MetricRow
            label="Autarky"
            value={fmtPctValue(metrics.renewableAutarky)}
            tip={AUTARKY_TIP}
          />
          <MetricRow
            label="Self-use"
            value={fmtPctValue(metrics.ownRenewableSelfConsumption)}
            tip={SELF_CONSUMPTION_TIP}
          />
        </div>
      </div>
    </>,
  );
}

/** Bare rounded percent from a 0..1 fraction — never includes the "%"; `<Value unit="%">` renders that
 *  so it is sized and bound per docs/architecture/number-typography.md. */
function fmtPctValue(x: number | null | undefined): string {
  return x == null ? "—" : `${Math.round(x * 100)}`;
}

function MetricRow({
  label,
  value,
  tip,
}: {
  label: string;
  value: string;
  tip: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-2 cursor-help"
      title={tip}
    >
      <span className="text-gray-400 truncate">{label}</span>
      <span className="text-gray-200 font-semibold">
        <Value value={value} unit={/\d/.test(value) ? "%" : undefined} />
      </span>
    </div>
  );
}
