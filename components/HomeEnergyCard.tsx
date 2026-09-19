"use client";

import type React from "react";
import Value from "@/components/ui/value";
import StatCardShell from "@/components/ui/stat-card-shell";
import TrendRow from "@/components/ui/trend-row";
import { ConcentricRings } from "@/components/ui/progress-ring";
import { CHART_COLORS } from "@/lib/chart-colors";
import { TILE_CAPTION } from "@/lib/tile-style";
import type { RenewablesSummary } from "@/lib/renewables/summary";
import {
  formatCarbonTotal,
  formatCentsPerKwh,
  formatDollars,
  formatGramsPerKwh,
  formatKwh,
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
 * The three ratios, as rings, outermost first — each ring's hue is its row's hue. Literal classes
 * (Tailwind's scanner) beside the rgb the SVG needs; the pair is the same colour.
 */
const RINGS = {
  renewable: { text: "text-green-400", rgb: CHART_COLORS.battery.main },
  selfUse: { text: "text-yellow-200", rgb: CHART_COLORS.solar.primary },
  autarky: { text: "text-cyan-400", rgb: CHART_COLORS.pool },
} as const;

/**
 * The "Home Energy" card — what the whole site CONSUMED over the dashboard's selected period, as the
 * Activity Rings card: three concentric rings on the left and their three values on the right, in
 * matching hues —
 *   - **Renewable** (outer): renewable share of everything consumed (own renewables + the grid's mix),
 *   - **Self-use** (middle): of the renewable WE generated, the share consumed on site,
 *   - **Autarky** (inner): consumption covered by our OWN renewable generation —
 * then the period's unit economics (energy, blended rate, emissions intensity) and absolute totals
 * (cost, carbon) as one caption line beneath.
 *
 * Purely presentational — the caller reduces {@link RenewablesSummary} client-side from the
 * attributed-flow payload the Sankey already fetched. The renewable ring is `metrics.renewableShare`
 * (denominator = total consumption); the rate and emissions intensity use FILTERED denominators
 * (known-intensity energy only) — see the reducer.
 */
export default function HomeEnergyCard({
  summary,
  periodLabel,
  measurementTime,
  staleThresholdSeconds,
  loading = false,
}: HomeEnergyCardProps) {
  const shell = (body: React.ReactNode) => (
    <StatCardShell
      title="Home Energy"
      titleSuffix={periodLabel}
      measurementTime={measurementTime}
      staleThresholdSeconds={staleThresholdSeconds}
    >
      {body}
    </StatCardShell>
  );

  if (loading) {
    // Mirrors the settled body box for box — the ring's square and three rows of REAL text in the
    // real classes, made transparent — so the card is the same size before and after its query
    // lands. Text rather than bars of a guessed height: an arbitrary font-size leaves the line box
    // at a fractional `normal` height that no `h-*` can name.
    return shell(
      <div data-skeleton="" aria-hidden>
        <RingsLayout
          rings={
            <div className="h-full w-full animate-pulse rounded-full border-[12px] border-white/[0.06]" />
          }
          rows={["Renewable", "Self-use", "Autarky"].map((label) => (
            <div
              key={label}
              className="animate-pulse rounded bg-white/[0.04] [&_*]:!text-transparent"
            >
              <TrendRow label={label} value="00%" />
            </div>
          ))}
          caption={
            <span className="animate-pulse rounded bg-white/[0.06] text-transparent">
              000 kWh · 00¢/kWh · 000 g/kWh · $00.00 · 00 kg CO₂
            </span>
          }
        />
      </div>,
    );
  }
  if (!summary || summary.consumptionKwh <= 0) {
    return shell(
      <p className="py-3 text-sm text-white/55">
        No attributed energy for this period yet.
      </p>,
    );
  }

  const { metrics } = summary;
  const ratios = [
    {
      key: "renewable",
      label: "Renewable",
      value: metrics.renewableShare,
      tip: SHARE_TIP,
      ...RINGS.renewable,
    },
    {
      key: "self-use",
      label: "Self-use",
      value: metrics.ownRenewableSelfConsumption,
      tip: SELF_CONSUMPTION_TIP,
      ...RINGS.selfUse,
    },
    {
      key: "autarky",
      label: "Autarky",
      value: metrics.renewableAutarky,
      tip: AUTARKY_TIP,
      ...RINGS.autarky,
    },
  ];

  // 🛑 Never greyed when stale. Every number here is a TOTAL over the navigator's period, and a
  // total does not go wrong because the newest live reading is old — greying it (the tile rule for a
  // live value) turned the whole card to grey whenever the feed lagged. The header's stale badge
  // still says the feed is behind.
  return shell(
    <RingsLayout
      rings={
        <ConcentricRings
          className="h-full w-full"
          rings={ratios.map((r) => ({
            fraction: r.value ?? 0,
            color: r.rgb,
            label: r.label,
          }))}
        />
      }
      rows={ratios.map((r) => (
        <TrendRow
          key={r.key}
          label={r.label}
          title={r.tip}
          value={
            <Value
              value={fmtPctValue(r.value)}
              unit={r.value != null ? "%" : undefined}
            />
          }
          valueColor={r.text}
        />
      ))}
      caption={
        <>
          <Value value={formatKwh(summary.consumptionKwh)} unit="kWh" /> used ·{" "}
          <span title={RATE_TIP} className="cursor-help">
            <Value
              value={formatCentsPerKwh(summary.avgCentsPerKwh)}
              unit={summary.avgCentsPerKwh != null ? "¢/kWh" : undefined}
            />
          </span>{" "}
          ·{" "}
          <Value
            value={formatGramsPerKwh(summary.avgGramsPerKwh)}
            unit={summary.avgGramsPerKwh != null ? "g/kWh" : undefined}
          />{" "}
          · {formatDollars(summary.costC)} ·{" "}
          {formatCarbonTotal(summary.emissionsG)} CO₂
        </>
      }
    />,
  );
}

/**
 * Rings left, rows right; stacked when the card is too narrow for both side by side. Shared by the
 * settled card and its skeleton so the two cannot measure differently.
 */
function RingsLayout({
  rings,
  rows,
  caption,
}: {
  rings: React.ReactNode;
  rows: React.ReactNode;
  caption: React.ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col items-center gap-4 @[300px]:flex-row @[300px]:items-center @[300px]:gap-6">
        <div className="aspect-square w-full max-w-[120px] shrink-0 @[300px]:w-[120px] @[520px]:w-[140px] @[520px]:max-w-[140px]">
          {rings}
        </div>
        <div className="w-full min-w-0 space-y-2 @[300px]:w-auto @[300px]:flex-1">
          {rows}
        </div>
      </div>
      <p className={`mt-3 ${TILE_CAPTION}`}>{caption}</p>
    </>
  );
}

/** Bare rounded percent from a 0..1 fraction — never includes the "%"; `<Value unit="%">` renders that
 *  so it is sized and bound per docs/architecture/number-typography.md. */
function fmtPctValue(x: number | null | undefined): string {
  return x == null ? "—" : `${Math.round(x * 100)}`;
}
