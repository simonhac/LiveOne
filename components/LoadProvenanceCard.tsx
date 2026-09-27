"use client";

import { Car } from "lucide-react";
import Stat from "@/components/ui/stat";
import StatCardShell from "@/components/ui/stat-card-shell";
import { StatGridSkeleton } from "@/components/ui/skeleton";
import { ROLE_CHROME } from "@/lib/role-chrome";
import type { LoadProvenanceSummary } from "@/lib/energy-flow-matrix";
import {
  formatCentsPerKwh,
  formatDollarsBare,
  dollarPrefix,
  formatGramsPerKwh,
  formatKwh,
  formatRenewablePctBare,
} from "@/lib/provenance-format";

export interface LoadProvenanceCardProps {
  summary: LoadProvenanceSummary | null;
  /** e.g. "last 30 days" or "July 2026". */
  periodLabel: string;
  /** Overrides the summary's load label (e.g. "EV Charging"). */
  title?: string;
  loading?: boolean;
}

/**
 * Presentational per-load provenance report — "over &lt;period&gt;: $X, Y% renewable, Z g/kWh, N%
 * estimated" for one load (the EV by default), plus the solar/battery/grid source split. Fed the typed
 * {@link LoadProvenanceSummary} the caller reduces client-side from the `source=modern` flow matrix (see
 * `reduceLoadProvenance`) — no data fetching here.
 *
 * The confidence chip surfaces `pctEstimated` so a number leaning on estimated/missing inputs never reads
 * as fact; the averages already use filtered (known-intensity) denominators upstream.
 */
export default function LoadProvenanceCard({
  summary,
  periodLabel,
  title,
  loading = false,
}: LoadProvenanceCardProps) {
  const heading = title ?? summary?.loadLabel ?? "Load";

  // The shared tile surface (docs/architecture/tile-style.md), like every other card. This one
  // carried its own shell — `gray-800/50` with a border and an 8px radius — until 2026-09-27, which
  // is also what kept its icon on a literal `cyan-400`: cyan is the POOL series, so it could be
  // neither `series-pool` (a lie) nor `series-ev` (a re-tone) while the card sat outside the system.
  // On `TileHeader` the question answers itself — `tone` IS the role's colour, so the EV card takes
  // the EV series, and the icon and the title take it together the way a tile's do.
  //
  // `periodReport`: this is a 30-day summary, not a reading, so it has no staleness. It must say so
  // explicitly — an absent `measurementTime` means "permanently stale", not "not applicable".
  const shell = (children: React.ReactNode) => (
    <StatCardShell
      title={heading}
      titleSuffix={periodLabel}
      icon={<Car size={16} />}
      tone={ROLE_CHROME.ev.value}
      periodReport
    >
      {children}
    </StatCardShell>
  );

  if (loading) {
    // Mirrors the settled body — the 4-stat grid, the source-split line, the confidence chip row —
    // instead of a flat 64px bar that the real content then doubles.
    return shell(
      <div>
        <StatGridSkeleton
          cells={4}
          gridClassName="grid grid-cols-2 gap-x-4 gap-y-3 @[360px]:grid-cols-4"
        />
        {/* Transparent text in the real classes rather than bars of a guessed height — see the
            note on the same pattern in HomeEnergyCard: only real glyphs reproduce a `normal`
            (fractional) line box exactly. */}
        <div className="mt-3 border-t border-tile-line pt-2" aria-hidden>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-transparent">
            <span className="animate-pulse rounded bg-skeleton-quiet">
              00% solar
            </span>
            <span className="animate-pulse rounded bg-skeleton-quiet">
              00% grid
            </span>
          </div>
        </div>
        <div
          className="mt-2 flex items-center gap-2 text-[11px] text-transparent"
          aria-hidden
        >
          <span className="animate-pulse rounded bg-skeleton-quiet">
            avg 00.0¢/kWh
          </span>
        </div>
      </div>,
    );
  }
  if (!summary || summary.energyKwh <= 0) {
    return shell(
      <p className="py-3 text-sm text-ink-faint">
        No attributed energy for this period yet.
      </p>,
    );
  }

  const renewableText = formatRenewablePctBare(summary.pctRenewable);
  const renewableGreen =
    summary.pctRenewable != null && summary.pctRenewable > 50;
  const emissionsText = formatGramsPerKwh(summary.avgGramsPerKwh);
  const energyText = formatKwh(summary.energyKwh);

  const total = summary.energyKwh;
  const splitPct = summary.sources
    .map((s) => ({
      label: shortSourceLabel(s.path, s.label),
      pct: total > 0 ? (100 * s.energyKwh) / total : 0,
    }))
    .filter((s) => s.pct >= 0.5);

  const estimated = Math.round(summary.pctEstimated);

  return shell(
    <div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 @[360px]:grid-cols-4">
        <Stat
          value={formatDollarsBare(summary.costC)}
          prefix={dollarPrefix(summary.costC)}
          caption="cost"
        />
        <Stat
          value={renewableText}
          unit="%"
          caption="renewable"
          valueClassName={renewableGreen ? "text-ok" : undefined}
        />
        <Stat value={emissionsText} unit="g" caption="CO₂ / kWh" />
        <Stat value={energyText} unit="kWh" caption="energy" />
      </div>

      {/* Source split (solar / battery / grid) */}
      {splitPct.length > 0 && (
        <div className="mt-3 border-t border-tile-line pt-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
            {splitPct.map((s) => (
              <span key={s.label}>
                <span className="font-semibold text-ink-control">
                  {Math.round(s.pct)}%
                </span>{" "}
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Confidence chip */}
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        {summary.avgCentsPerKwh != null && (
          <span className="text-ink-faint">
            avg {formatCentsPerKwh(summary.avgCentsPerKwh)}¢/kWh
          </span>
        )}
        {estimated > 0 && (
          <span className="ml-auto rounded-full border border-warn-line bg-warn-wash px-2 py-0.5 text-warn-ink">
            {estimated}% estimated
          </span>
        )}
      </div>
    </div>,
  );
}

/** Short human label for a source path used in the split line. */
function shortSourceLabel(path: string, label: string): string {
  if (path === "source.solar" || path.startsWith("source.solar."))
    return "solar";
  if (path === "source.battery") return "battery";
  if (path === "source.grid") return "grid";
  return label.toLowerCase();
}
