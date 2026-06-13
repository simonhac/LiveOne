"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Clock, Zap } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type { GridLiveValues } from "@/lib/queries/grid";

export interface GridSignalsCardProps {
  regionLabel: string;
  values: GridLiveValues | null;
  staleThresholdSeconds?: number;
}

/**
 * Presentational "Local Grid (NEM)" card. Shows three live grid signals for the
 * household's local NEM region: spot price (¢/kWh), emissions intensity
 * (gCO₂/kWh), and renewables (%). No data fetching happens here — the typed
 * `values` prop is supplied by the caller (cross-system OE region fetch).
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

  // Display values (client-side conversions per the OE stored units).
  const priceText = price != null ? `${(price / 10).toFixed(1)}¢` : "—";
  const emissionsText =
    emissions != null ? `${Math.round(emissions * 1000)}` : "—";
  const renewablesText =
    renewables != null ? `${Math.round(renewables)}%` : "—";
  const renewablesGreen = renewables != null && renewables > 50;

  return (
    <div
      className={`bg-gray-800/50 border border-gray-700 rounded-lg p-2 md:p-4 relative overflow-hidden ${isStale ? "opacity-75" : ""} ${ttInterphases.className}`}
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
          <span className="text-gray-400 text-xs md:text-sm truncate">
            Local Grid · {regionLabel}
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

        {/* 3-up stat grid */}
        <div className="grid grid-cols-3 gap-2">
          {/* Price */}
          <div>
            <p className="text-xl md:text-2xl font-bold text-gray-200">
              {priceText}
              {price != null && (
                <>
                  {" "}
                  <span className="text-sm md:text-base font-semibold">
                    /kWh
                  </span>
                </>
              )}
            </p>
            <p className="text-xs text-gray-400">Price</p>
          </div>

          {/* Emissions */}
          <div>
            <p className="text-xl md:text-2xl font-bold text-gray-200">
              {emissionsText}
              {emissions != null && (
                <>
                  {" "}
                  <span className="text-sm md:text-base font-semibold">
                    g CO₂/kWh
                  </span>
                </>
              )}
            </p>
            <p className="text-xs text-gray-400">Emissions</p>
          </div>

          {/* Renewables */}
          <div>
            <p
              className={`text-xl md:text-2xl font-bold ${renewablesGreen ? "text-green-400" : "text-gray-200"}`}
            >
              {renewablesText}
            </p>
            <p className="text-xs text-gray-400">Renewables</p>
          </div>
        </div>
      </div>
    </div>
  );
}
