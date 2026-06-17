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

/**
 * Unit / suffix text styled like the power cards (e.g. solar's "kW"): small + semibold, sitting
 * next to the value. By default it inherits the value's colour (the power-card look); `muted`
 * recesses it (the trailing "RE"). `gap` adds a thin space before it ("6.9 kW"); omit to attach
 * the symbol to the number ("1.5¢…", "24%").
 */
function Unit({
  children,
  gap = false,
  muted = false,
}: {
  children: ReactNode;
  gap?: boolean;
  muted?: boolean;
}) {
  return (
    <>
      {gap && " "}
      <span
        className={`text-sm font-semibold md:text-base${muted ? " text-gray-400" : ""}`}
      >
        {children}
      </span>
    </>
  );
}

/** A compact, label-less stat: bold value + power-card-style unit. Never truncates. */
function Stat({
  value,
  unit,
  valueClassName,
}: {
  value: string;
  unit?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <p
      className={`whitespace-nowrap text-xl font-bold leading-none md:text-2xl ${
        valueClassName ?? "text-gray-200"
      }`}
    >
      {value}
      {unit}
    </p>
  );
}

/**
 * Presentational "<region> Grid" card (e.g. "NSW Grid"). Shows four live grid signals for the
 * household's local NEM region: spot price ($/MWh), emissions intensity (g CO₂e/kWh),
 * renewables (%), and operational demand (MW). No data fetching happens here — the typed `values`
 * prop is supplied by the caller (cross-system OE region fetch).
 *
 * Layout: four compact, label-less stats (bold value + a power-card-style unit, like solar's
 * "kW") in an `@container` grid that reflows by the card's OWN width — 1 column when narrow, then
 * 2/3/4 columns as it widens. Price reads "$N/MWh", emissions abbreviates to "EI"
 * (emissions intensity), renewables reads "<n>% RE", demand reads "<n> MW". Values never truncate.
 *
 * Staleness follows Tile: the newest measurementTime across the present
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
  const demand = values?.demand?.value ?? null;

  // Newest measurement time across the present metrics (epoch ms), or null.
  const measurementTimes = [
    values?.price?.measurementTime,
    values?.emissionsIntensity?.measurementTime,
    values?.renewables?.measurementTime,
    values?.demand?.measurementTime,
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
  // Price is stored in $/MWh; show it directly as integer dollars ("$2/MWh").
  const priceText = price != null ? `$${Math.round(price)}` : "—";
  // 0 g/kWh is physically impossible for a generating grid (a transient OE artifact); show
  // an em-dash rather than a bogus "0" until the next good reading lands.
  const emissionsText =
    emissions != null && emissions > 0
      ? `${Math.round(emissions * 1000)}`
      : "—";
  const renewablesText = renewables != null ? `${Math.round(renewables)}` : "—";
  const renewablesGreen = renewables != null && renewables > 50;
  // Operational demand is stored in MW; show integer MW with a thousands separator ("7,234").
  const demandText =
    demand != null ? Math.round(demand).toLocaleString("en-AU") : "—";

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

        {/* Compact, label-less stats: bold value + power-card-style unit. 1 → 2 → 3 → 4 columns as
            the card widens (its OWN width via @container). Price reads "$N/MWh"; emissions uses
            "EI" (emissions intensity); renewables is "<n>% RE"; demand is "<n> MW". */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 @[180px]:grid-cols-2 @[300px]:grid-cols-3 @[400px]:grid-cols-4">
          <Stat
            value={priceText}
            unit={price != null ? <Unit muted>/MWh</Unit> : undefined}
          />
          <Stat
            value={emissionsText}
            unit={
              emissions != null ? (
                <Unit gap muted>
                  EI
                </Unit>
              ) : undefined
            }
          />
          <Stat
            value={renewablesText}
            unit={
              renewables != null ? (
                <>
                  <Unit>%</Unit>
                  <Unit gap muted>
                    RE
                  </Unit>
                </>
              ) : undefined
            }
            valueClassName={
              renewablesGreen ? "text-green-400" : "text-gray-200"
            }
          />
          <Stat
            value={demandText}
            unit={
              demand != null ? (
                <Unit gap muted>
                  MW
                </Unit>
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
