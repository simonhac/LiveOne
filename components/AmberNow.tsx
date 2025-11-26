"use client";

import { useDashboardRefresh } from "@/hooks/useDashboardRefresh";
import { getPriceLevel, type PriceLevel } from "./AmberPriceIndicator";
import { ttInterphases } from "@/lib/fonts/amber";

/**
 * Extended point value that can handle both numeric and string values
 * (e.g., price in cents or descriptor like "extremelyLow")
 */
interface LatestValue {
  value: number | string;
  measurementTime?: Date;
  metricUnit?: string;
  displayName?: string;
}

interface AmberNowProps {
  /**
   * Latest values from KV cache, keyed by logical path
   * Expected paths:
   * - bidi.grid.import/rate (number, c/kWh)
   * - bidi.grid.export/rate (number, c/kWh)
   * - bidi.grid.renewables/proportion (number, %)
   * - bidi.grid.import/descriptor (string, price level)
   * - bidi.grid.import/spikeStatus (string)
   * - bidi.grid.tariff/code (string)
   * - bidi.grid.interval/start (number, ms)
   * - bidi.grid.interval/end (number, ms)
   */
  latest: Record<string, LatestValue | null> | null;
}

/**
 * Get a numeric value from latest values store
 */
function getNumericValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): number | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "number") return point.value;
  // Try to parse string as number
  if (typeof point.value === "string") {
    const parsed = parseFloat(point.value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Get a string value from latest values store
 */
function getStringValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): string | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "string") return point.value;
  if (typeof point.value === "number") return String(point.value);
  return null;
}

/**
 * Map Amber API descriptor to our PriceLevel type
 */
function descriptorToPriceLevel(descriptor: string | null): PriceLevel {
  if (!descriptor) return "missing";

  switch (descriptor) {
    case "extremelyLow":
      return "extremelyLow";
    case "veryLow":
      return "veryLow";
    case "low":
      return "low";
    case "neutral":
      return "neutral";
    case "high":
    case "spike":
      return "high";
    default:
      return "neutral";
  }
}

/**
 * Human-readable label for price level (all caps like Amber iPhone app)
 */
function getPriceLevelLabel(priceLevel: PriceLevel): string {
  switch (priceLevel) {
    case "extremelyLow":
      return "EXTREMELY LOW PRICES";
    case "veryLow":
      return "VERY LOW PRICES";
    case "low":
      return "LOW PRICES";
    case "neutral":
      return "NEUTRAL PRICES";
    case "high":
      return "HIGH PRICES";
    case "missing":
      return "PRICE UNAVAILABLE";
  }
}

/**
 * Get gradient background for price level circle (matches Amber's exact gradients)
 */
function getPriceLevelGradient(priceLevel: PriceLevel): string {
  switch (priceLevel) {
    case "extremelyLow":
    case "veryLow":
      // Amber's green gradient
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(0, 255, 168) 0%, rgb(0, 202, 147) 100%)";
    case "low":
    case "neutral":
      // Amber's yellow/amber gradient
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(255, 230, 120) 0%, rgb(255, 198, 36) 100%)";
    case "high":
      // Amber's orange gradient
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(255, 180, 100) 0%, rgb(255, 130, 50) 100%)";
    case "missing":
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(120, 120, 120) 0%, rgb(80, 80, 80) 100%)";
  }
}

/**
 * Generate summary message based on price level and renewables
 */
function getSummaryMessage(
  priceLevel: PriceLevel,
  renewables: number | null,
  spikeStatus: string | null,
): string {
  const isGreen = renewables !== null && renewables > 50;
  const isSpike = spikeStatus === "spike" || spikeStatus === "potential";

  switch (priceLevel) {
    case "extremelyLow":
      if (isGreen) {
        return "Wow! It's really cheap and really green to use energy right now!";
      }
      return "Great time to use energy — prices are extremely low!";

    case "veryLow":
      if (isGreen) {
        return "Good time to use energy — cheap and green!";
      }
      return "Prices are very low — good time to use energy.";

    case "low":
      return "Prices are low — reasonable time to use energy.";

    case "neutral":
      return "Prices are normal for this time of day.";

    case "high":
      if (isSpike) {
        return "Warning: Prices are spiking. Consider reducing usage.";
      }
      return "Prices are elevated. Consider delaying non-essential usage.";

    case "missing":
      return "Price data is currently unavailable.";
  }
}

/**
 * Small diamond icon with exclamation mark (matches Amber's design for extremelyLow)
 */
function DiamondIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      className={className}
      aria-hidden="true"
    >
      <g fill="none" fillRule="evenodd">
        <path
          fill="rgb(0, 11, 36)"
          fillRule="nonzero"
          d="M72.6320686,3.57551988 L124.42448,55.3679314 C129.19184,60.1352913 129.19184,67.8647087 124.42448,72.6320686 L72.6320686,124.42448 C67.8647087,129.19184 60.1352913,129.19184 55.3679314,124.42448 L3.57551988,72.6320686 C-1.19183996,67.8647087 -1.19183996,60.1352913 3.57551988,55.3679314 L55.3679314,3.57551988 C60.1352913,-1.19183996 67.8647087,-1.19183996 72.6320686,3.57551988 Z M61.2847738,9.17661734 L61.1226438,9.33023227 L9.33023227,61.1226438 C7.79408299,62.6587931 7.74287801,65.1175685 9.17661734,66.7152262 L9.33023227,66.8773562 L61.1226438,118.669768 C62.6587931,120.205917 65.1175685,120.257122 66.7152262,118.823383 L66.8773562,118.669768 L118.669768,66.8773562 C120.205917,65.3412069 120.257122,62.8824315 118.823383,61.2847738 L118.669768,61.1226438 L66.8773562,9.33023227 C65.3412069,7.79408299 62.8824315,7.74287801 61.2847738,9.17661734 Z M64.0003373,83.7190083 C67.6886211,83.7190083 70.9461564,86.8956312 71,90.8180699 C70.9461564,94.7957543 67.6886211,98 64.0003373,98 C60.123601,98 56.946831,94.7957543 57.0006745,90.8180699 C56.946831,86.8956312 60.123601,83.7190083 64.0003373,83.7190083 Z M71,26 L69.7196819,74.7933884 L58.2803181,74.7933884 L57,26 L71,26 Z"
        />
      </g>
    </svg>
  );
}

/**
 * AmberNow component - displays live Amber Electric price data
 * Matches Amber app's design with large circle containing all info
 */
export default function AmberNow({ latest }: AmberNowProps) {
  // Extract values from latest store
  const importPrice = getNumericValue(latest, "bidi.grid.import/rate");
  const feedInPrice = getNumericValue(latest, "bidi.grid.export/rate");
  const renewables = getNumericValue(latest, "bidi.grid.renewables/proportion");
  const descriptor = getStringValue(latest, "bidi.grid.import/descriptor");
  const spikeStatus = getStringValue(latest, "bidi.grid.import/spikeStatus");

  // Determine price level from descriptor or fall back to price-based calculation
  const priceLevel = descriptor
    ? descriptorToPriceLevel(descriptor)
    : getPriceLevel(importPrice);

  // Listen for dashboard refresh events
  useDashboardRefresh(() => {
    // Component will re-render when parent refreshes data
  });

  // Don't render if no data available
  if (importPrice === null) {
    return null;
  }

  const priceLevelLabel = getPriceLevelLabel(priceLevel);
  const summaryMessage = getSummaryMessage(priceLevel, renewables, spikeStatus);
  const circleGradient = getPriceLevelGradient(priceLevel);
  const showFeedIn = feedInPrice !== null;
  const showDiamond = priceLevel === "extremelyLow";

  return (
    <div
      className={`w-full max-w-md mx-auto p-4 md:p-6 bg-[rgb(40,49,66)] border border-gray-700 ${ttInterphases.className}`}
    >
      <h2 className="text-sm font-semibold text-gray-400 mb-6 tracking-wide">
        LIVE PRICE
      </h2>

      {/* Main price display - large circle with gradient background */}
      <div className="flex flex-col items-center mb-6">
        <div
          className="rounded-full flex flex-col items-center justify-center pt-4 pb-4"
          style={{
            background: circleGradient,
            width: "280px",
            height: "280px",
          }}
        >
          {/* Diamond icon at top for extremely low prices - in normal flex flow */}
          {showDiamond && <DiamondIcon className="w-6 h-6 mb-1" />}

          {/* Price level label */}
          <div
            className="text-center mb-1"
            style={{
              color: "rgb(0, 0, 0)",
              fontSize: "16px",
              fontWeight: 700,
            }}
          >
            {priceLevelLabel}
          </div>

          {/* Large price */}
          <div
            style={{
              color: "rgb(0, 11, 36)",
              fontSize: "80px",
              fontWeight: 700,
              lineHeight: 1,
            }}
          >
            {Math.round(importPrice)}¢
          </div>
          <div
            style={{
              color: "rgb(0, 0, 0)",
              fontSize: "12px",
              fontWeight: 400,
              marginBottom: "8px",
            }}
          >
            /kWh
          </div>

          {/* Renewables percentage */}
          {renewables !== null && (
            <div className="text-center">
              <span
                style={{
                  color: "rgb(0, 0, 0)",
                  fontSize: "32px",
                  fontWeight: 700,
                }}
              >
                {Math.round(renewables)}%
              </span>
              <div
                style={{
                  color: "rgb(0, 0, 0)",
                  fontSize: "12px",
                  fontWeight: 400,
                }}
              >
                renewables in grid
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Summary card - light background like Amber */}
      <div className="bg-slate-200 p-4 mb-4">
        <h3 className="text-xs font-semibold text-gray-500 mb-1 tracking-wide">
          SUMMARY
        </h3>
        <p className="text-sm" style={{ color: "rgb(0, 0, 0)" }}>
          {summaryMessage}
        </p>
      </div>

      {/* Feed-in section - only show when feed-in rate available */}
      {showFeedIn && (
        <div className="border-t border-gray-600 pt-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">☀️</span>
            <span className="text-base font-medium text-gray-300">
              Solar Feed-in
            </span>
          </div>
          <div>
            <span
              style={{
                color: "white",
                fontSize: "28px",
                fontWeight: 700,
              }}
            >
              {feedInPrice < 0 ? "" : "-"}
              {Math.abs(Math.round(feedInPrice))}¢
            </span>
            <span
              className="text-gray-400 ml-1"
              style={{ fontSize: "14px", fontWeight: 400 }}
            >
              /kWh
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
