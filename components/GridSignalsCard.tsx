"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Clock, Zap } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type { GridLiveValues } from "@/lib/grid/latest";

export interface GridSignalsCardProps {
  regionLabel: string;
  values: GridLiveValues | null;
  staleThresholdSeconds?: number;
}

/** Small, non-bold, muted unit text. Sizes relative to the value it follows (em-based). */
function Unit({ children }: { children: ReactNode }) {
  return (
    <span className="text-[0.62em] font-normal text-gray-400">{children}</span>
  );
}

/**
 * Typographic fraction (numerator over a rule over denominator) for a unit pair like
 * "g CO₂e / kWh". Small + non-bold; sits inline next to a value via align-middle.
 */
function GridFraction({ top, bottom }: { top: string; bottom: string }) {
  return (
    <span className="inline-flex flex-col items-center align-middle text-[0.5em] font-normal leading-none text-gray-400">
      <span className="whitespace-nowrap px-0.5">{top}</span>
      <span className="my-px w-full border-t border-gray-500" />
      <span className="whitespace-nowrap px-0.5">{bottom}</span>
    </span>
  );
}

/** A single labelled stat: small label on top, big bold value + recessed unit below. */
function Stat({
  label,
  value,
  unit,
  valueClassName,
}: {
  label: string;
  value: string;
  /** Rendered only when present (omitted when the value is the em-dash). */
  unit?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-gray-400">{label}</p>
      <p
        className={`mt-0.5 flex items-baseline gap-1 text-xl font-bold leading-none md:text-2xl ${
          valueClassName ?? "text-gray-200"
        }`}
      >
        <span className="truncate">{value}</span>
        {unit ? <span className="shrink-0">{unit}</span> : null}
      </p>
    </div>
  );
}

/**
 * Presentational "<region> Grid" card (e.g. "NSW Grid"). Shows three live grid signals for the
 * household's local NEM region: spot price (¢/kWh), emissions intensity (g CO₂e/kWh), and
 * renewables (%). No data fetching happens here — the typed `values` prop is supplied by the
 * caller (cross-system OE region fetch).
 *
 * Layout: the three stats sit in an `@container` grid that reflows by the card's OWN width —
 * 1 column when narrow, 2 from 200px, 3 (the familiar 3-up) from 340px — so values never collide
 * at small widths. Units are small + non-bold; emissions uses a g CO₂e/kWh fraction.
 *
 * Staleness follows PowerCard: the newest measurementTime across the present
 * metrics is compared against `staleThresholdSeconds` (recomputed every second);
 * when stale, the card dims and a Clock icon exposes a "Last update" tooltip.
 */
export default function GridSignalsCard({
  regionLabel,
  values,
  // OpenElectricity is 5-min-native and measurementTime is the interval END, so the freshest
  // reading is routinely 5+ min old just before the next interval publishes (plus poll/relay lag).
  // 900s keeps the card "fresh" across a normal cycle and a single missed interval.
  staleThresholdSeconds = 900,
}: GridSignalsCardProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const clockIconRef = useRef<HTMLDivElement>(null);

  // Recompute the current time every second so staleness stays live.
  useEffect(() => {
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const price = values?.price?.value ?? null;
  const emissions = values?.emissionsIntensity?.value ?? null;
  const renewables = values?.renewables?.value ?? null;

  // Newest measurement time across the present metrics (epoch ms), or null.
  const measurementTimes = [
    values?.price?.measurementTime,
    values?.emissionsIntensity?.measurementTime,
    values?.renewables?.measurementTime,
  ]
    .filter((t): t is string => typeof t === "string")
    .map((t) => new Date(t).getTime())
    .filter((ms) => !Number.isNaN(ms));
  const newestMs = measurementTimes.length
    ? Math.max(...measurementTimes)
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
      if (x + 200 > viewportWidth) {
        x = viewportWidth - 210;
      }
      setTooltipPosition({ x, y });
    }
    setIsTooltipVisible(true);
  };

  // Format tooltip date: show time first, omit date if today.
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

    if (isToday) {
      return timeStr;
    }

    const dateStr = date.toLocaleString("en-AU", {
      timeZone: "Australia/Sydney",
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    return `${timeStr}, ${dateStr}`;
  };

  // Defensive: nothing to show at all.
  if (!regionLabel && values === null) {
    return null;
  }

  // Display values (client-side conversions per the OE stored units). Units render separately
  // (small + non-bold), so these are the bare numbers only.
  const priceText = price != null ? `${(price / 10).toFixed(1)}` : "—";
  const emissionsText =
    emissions != null ? `${Math.round(emissions * 1000)}` : "—";
  const renewablesText = renewables != null ? `${Math.round(renewables)}` : "—";
  const renewablesGreen = renewables != null && renewables > 50;

  // Card title, e.g. "NSW Grid". The caller passes the short NEM label ("NSW"); strip a trailing
  // region index defensively so a raw "NSW1" still renders "NSW Grid".
  const regionShort = regionLabel.replace(/\d+$/, "").trim() || regionLabel;

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
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-blue-400 flex-shrink-0">
            <Zap size={16} />
          </span>
          <span className="text-gray-300 text-xs md:text-sm truncate">
            {regionShort} Grid
          </span>
          {isStale && newestMs !== null && (
            <>
              <div
                ref={clockIconRef}
                onMouseEnter={handleClockMouseEnter}
                onMouseLeave={() => setIsTooltipVisible(false)}
                className="text-gray-500 cursor-help flex-shrink-0"
              >
                <Clock size={12} className="md:w-[14px] md:h-[14px]" />
              </div>
              {isTooltipVisible &&
                typeof document !== "undefined" &&
                createPortal(
                  <div
                    className="fixed z-[9999] bg-black border border-gray-700 rounded-lg px-3 py-2 shadow-xl text-xs text-white whitespace-nowrap pointer-events-none"
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

        {/* Stats: 1 → 2 → 3 columns as the card widens (its OWN width via @container), so values
            never collide at narrow widths. 3-up only from 340px, where emissions (the widest
            stat: value + the g CO₂e/kWh fraction) still fits unclipped. */}
        <div className="grid grid-cols-1 gap-3 @[200px]:grid-cols-2 @[340px]:grid-cols-3">
          <Stat
            label="Price"
            value={priceText}
            unit={price != null ? <Unit>¢/kWh</Unit> : undefined}
          />
          <Stat
            label="Emissions"
            value={emissionsText}
            unit={
              emissions != null ? (
                <GridFraction top="g CO₂e" bottom="kWh" />
              ) : undefined
            }
          />
          <Stat
            label="Renewables"
            value={renewablesText}
            unit={renewables != null ? <Unit>%</Unit> : undefined}
            valueClassName={
              renewablesGreen ? "text-green-400" : "text-gray-200"
            }
          />
        </div>
      </div>
    </div>
  );
}
