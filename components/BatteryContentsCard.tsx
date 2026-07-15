"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Clock, Battery } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type { BatteryContentsValues } from "@/lib/battery/contents-latest";

export interface BatteryContentsCardProps {
  values: BatteryContentsValues | null;
  title?: string;
  staleThresholdSeconds?: number;
}

/** A labelled stat: bold value (+ inline unit) over a tiny uppercase caption. Never truncates. */
function Stat({
  value,
  unit,
  caption,
  valueClassName,
}: {
  value: string;
  unit?: ReactNode;
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
        {unit}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-gray-500 md:text-xs">
        {caption}
      </p>
    </div>
  );
}

/** Small semibold unit suffix, matching the power/blend cards. */
function Unit({
  children,
  gap = true,
}: {
  children: ReactNode;
  gap?: boolean;
}) {
  return (
    <>
      {gap && " "}
      <span className="text-sm font-semibold text-gray-400 md:text-base">
        {children}
      </span>
    </>
  );
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
 * Layout/staleness mirror BatteryBlendCard/GridSignalsCard: an `@container` grid of labelled stats that
 * reflows by the card's OWN width; when stale the card dims and a Clock tooltip shows the last update. The
 * absolute totals degrade to "—" during warm-up (no `stored-energy` point yet); the export stat is hidden
 * without a tariff; an empty battery reads "0.0 kWh" with em-dashes elsewhere.
 */
export default function BatteryContentsCard({
  values,
  title = "Battery",
  staleThresholdSeconds = 900,
}: BatteryContentsCardProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const clockIconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const newestMs =
    values?.measurementTime != null
      ? new Date(values.measurementTime).getTime()
      : null;
  const secondsSinceUpdate =
    newestMs !== null ? Math.floor((nowMs - newestMs) / 1000) : Infinity;
  const isStale = secondsSinceUpdate > staleThresholdSeconds;

  const handleClockMouseEnter = () => {
    if (clockIconRef.current) {
      const rect = clockIconRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      let x = rect.left;
      const y = rect.bottom + 8;
      if (x + 200 > viewportWidth) x = viewportWidth - 210;
      setTooltipPosition({ x, y });
    }
    setIsTooltipVisible(true);
  };

  const formatTooltipDate = (date: Date): string => {
    const now = new Date();
    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();
    const timeStr = date.toLocaleString("en-AU", {
      timeZone: "Australia/Sydney",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    if (isToday) return timeStr;
    const dateStr = date.toLocaleString("en-AU", {
      timeZone: "Australia/Sydney",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${timeStr}, ${dateStr}`;
  };

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
    totalCarbonG == null
      ? null
      : totalCarbonG >= 1000
        ? `${(totalCarbonG / 1000).toFixed(1)} kg`
        : `${Math.round(totalCarbonG)} g`;

  const hasSecondary =
    totalCostActualC != null ||
    carbonTotalText != null ||
    hasExport ||
    showForgone;

  return (
    <div
      className={`@container bg-gray-800/50 border border-gray-700 rounded-lg p-2 md:p-4 relative overflow-hidden ${isStale ? "opacity-75" : ""} ${ttInterphases.className}`}
    >
      {isStale && (
        <div
          className="absolute inset-0 opacity-30 pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent, transparent 10px, rgba(255,255,255,0.15) 10px, rgba(255,255,255,0.15) 20px)",
          }}
        />
      )}
      <div className="relative z-10">
        {/* Header row */}
        <div className="mb-2 flex items-center gap-1.5">
          <span className="flex-shrink-0 text-green-400">
            <Battery size={16} />
          </span>
          <span className="truncate text-xs text-gray-300 md:text-sm">
            {title}
          </span>
          {isStale && newestMs !== null && (
            <>
              <div
                ref={clockIconRef}
                onMouseEnter={handleClockMouseEnter}
                onMouseLeave={() => setIsTooltipVisible(false)}
                className="flex-shrink-0 cursor-help text-gray-500"
              >
                <Clock size={12} className="md:w-[14px] md:h-[14px]" />
              </div>
              {isTooltipVisible &&
                typeof document !== "undefined" &&
                createPortal(
                  <div
                    className="fixed z-[9999] whitespace-nowrap rounded-lg border border-gray-700 bg-black px-3 py-2 text-xs text-white shadow-xl pointer-events-none"
                    style={{
                      left: `${tooltipPosition.x}px`,
                      top: `${tooltipPosition.y}px`,
                    }}
                  >
                    Last update: {formatTooltipDate(new Date(newestMs))}
                  </div>,
                  document.body,
                )}
            </>
          )}
        </div>

        {/* Headline: usable kWh · cost/kWh · emissions/kWh · renewable — the unit
            economics of the stored energy. 2 → 3 → 4 columns as the card widens. */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 @[360px]:grid-cols-3 @[520px]:grid-cols-4">
          <Stat
            value={storedEnergyKwh != null ? storedEnergyKwh.toFixed(1) : "—"}
            unit={storedEnergyKwh != null ? <Unit>kWh</Unit> : undefined}
            caption="usable"
          />
          <Stat
            value={priceActual != null ? cents(priceActual) : "—"}
            unit={priceActual != null ? <Unit gap={false}>¢</Unit> : undefined}
            caption="cost / kWh"
          />
          <Stat
            value={
              carbonIntensity != null ? `${Math.round(carbonIntensity)}` : "—"
            }
            unit={carbonIntensity != null ? <Unit>g</Unit> : undefined}
            caption="emissions / kWh"
          />
          <Stat
            value={
              renewableFraction != null
                ? `${Math.round(renewableFraction)}`
                : "—"
            }
            unit={
              renewableFraction != null ? <Unit gap={false}>%</Unit> : undefined
            }
            caption="renewable"
            valueClassName={renewableGreen ? "text-green-400" : "text-gray-100"}
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
                {priceOpportunity != null &&
                  ` · ${cents(priceOpportunity)}¢/kWh`}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
