"use client";

import { Car } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type { LoadProvenanceSummary } from "@/lib/energy-flow-matrix";
import {
  formatCentsPerKwh,
  formatDollars,
  formatGramsPerKwh,
  formatKwh,
  formatRenewablePct,
} from "@/lib/provenance-format";

export interface LoadProvenanceCardProps {
  summary: LoadProvenanceSummary | null;
  /** e.g. "last 30 days" or "July 2026". */
  periodLabel: string;
  /** Overrides the summary's load label (e.g. "EV Charging"). */
  title?: string;
  loading?: boolean;
}

/** A labelled stat: big value + tiny caption underneath. */
function Stat({
  value,
  caption,
  valueClassName,
}: {
  value: string;
  caption: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <p
        className={`whitespace-nowrap text-xl font-bold leading-none md:text-2xl ${
          valueClassName ?? "text-gray-100"
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-gray-500 md:text-xs">
        {caption}
      </p>
    </div>
  );
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

  const shell = (children: React.ReactNode) => (
    <div
      className={`bg-gray-800/50 border border-gray-700 rounded-lg p-3 md:p-4 ${ttInterphases.className}`}
    >
      <div className="mb-3 flex items-center gap-1.5">
        <span className="flex-shrink-0 text-cyan-400">
          <Car size={16} />
        </span>
        <span className="truncate text-xs text-gray-300 md:text-sm">
          {heading}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-500 md:text-xs">
          {periodLabel}
        </span>
      </div>
      {children}
    </div>
  );

  if (loading) {
    return shell(
      <div className="h-16 animate-pulse rounded bg-gray-700/40" aria-hidden />,
    );
  }
  if (!summary || summary.energyKwh <= 0) {
    return shell(
      <p className="py-3 text-sm text-gray-500">
        No attributed energy for this period yet.
      </p>,
    );
  }

  const dollarsText = formatDollars(summary.costC);
  const renewableText = formatRenewablePct(summary.pctRenewable);
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
        <Stat value={dollarsText} caption="cost" />
        <Stat
          value={renewableText}
          caption="renewable"
          valueClassName={renewableGreen ? "text-green-400" : "text-gray-100"}
        />
        <Stat
          value={emissionsText}
          caption="g CO₂ / kWh"
          valueClassName="text-gray-100"
        />
        <Stat value={energyText} caption="kWh" />
      </div>

      {/* Source split (solar / battery / grid) */}
      {splitPct.length > 0 && (
        <div className="mt-3 border-t border-gray-700/60 pt-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
            {splitPct.map((s) => (
              <span key={s.label}>
                <span className="font-semibold text-gray-200">
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
          <span className="text-gray-500">
            avg {formatCentsPerKwh(summary.avgCentsPerKwh)}¢/kWh
          </span>
        )}
        {estimated > 0 && (
          <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
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
