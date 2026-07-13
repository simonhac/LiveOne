"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Clock, BatteryCharging } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type { BatteryBlendValues } from "@/lib/battery/blend-latest";

export interface BatteryBlendCardProps {
  values: BatteryBlendValues | null;
  title?: string;
  staleThresholdSeconds?: number;
}

/** Unit / suffix text styled like the power cards: small + semibold, next to the value. */
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
      {gap && " "}
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
 * Presentational "Battery Blend" card — the emissions intensity / renewable fraction / price of the
 * energy CURRENTLY SITTING IN THE BATTERY (what it would vend if discharged right now), from the
 * weighted-average provenance fold. The three values are derived blend points that live on the Area's
 * helper device (see docs/architecture/battery-provenance.md); no data fetching happens here — the
 * typed `values` prop is supplied by the caller (a `dashboardDataQuery` selector, `batteryBlendFromData`).
 *
 * Layout mirrors GridSignalsCard: compact label-less stats in an `@container` grid that reflows by the
 * card's OWN width. Carbon reads "<n> g/kWh", renewable "<n>% RE" (green when majority-renewable), price
 * "<n>¢/kWh" (may be negative when the grid pays you). Values never truncate.
 *
 * Staleness follows GridSignalsCard: the newest measurementTime across present metrics vs.
 * `staleThresholdSeconds` (recomputed every second); when stale the card dims and a Clock tooltip shows
 * the last update. The blend can be absent during warm-up (empty battery → nothing to vend) → em-dashes.
 */
export default function BatteryBlendCard({
  values,
  title = "Battery Blend",
  // The blend is written from 5-min-native inputs (interval END), so the freshest value is routinely a
  // few minutes old between intervals; 900s keeps it "fresh" across a normal cycle + one missed interval.
  staleThresholdSeconds = 900,
}: BatteryBlendCardProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const clockIconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const carbon = values?.carbonIntensity?.value ?? null;
  const renewable = values?.renewableFraction?.value ?? null;
  const price = values?.price?.value ?? null;

  const measurementTimes = [
    values?.carbonIntensity?.measurementTime,
    values?.renewableFraction?.measurementTime,
    values?.price?.measurementTime,
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

  // Display values. Renewable/carbon/price are already stored in their natural units (%, gCO2/kWh,
  // cents/kWh — same as the generic device-metrics card renders them), so these are bare numbers.
  const carbonText = carbon != null ? `${Math.round(carbon)}` : "—";
  const renewableText = renewable != null ? `${Math.round(renewable)}` : "—";
  const renewableGreen = renewable != null && renewable > 50;
  const priceText =
    price != null
      ? `${price < 0 ? "−" : ""}${Math.abs(price).toFixed(1)}`
      : "—";

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
          <span className="text-green-400 flex-shrink-0">
            <BatteryCharging size={16} />
          </span>
          <span className="text-gray-300 text-xs md:text-sm truncate">
            {title}
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

        {/* Compact label-less stats: carbon "<n> g/kWh", renewable "<n>% RE", price "<n>¢/kWh".
            1 → 2 → 3 columns as the card widens (its OWN width via @container). */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 @[180px]:grid-cols-2 @[300px]:grid-cols-3">
          <Stat
            value={carbonText}
            unit={
              carbon != null ? (
                <Unit gap muted>
                  g/kWh
                </Unit>
              ) : undefined
            }
          />
          <Stat
            value={renewableText}
            unit={
              renewable != null ? (
                <>
                  <Unit>%</Unit>
                  <Unit gap muted>
                    RE
                  </Unit>
                </>
              ) : undefined
            }
            valueClassName={renewableGreen ? "text-green-400" : "text-gray-200"}
          />
          <Stat
            value={priceText}
            unit={price != null ? <Unit muted>¢/kWh</Unit> : undefined}
          />
        </div>
      </div>
    </div>
  );
}
