"use client";

import { useDashboardRefresh } from "@/hooks/useDashboardRefresh";
import { ttInterphases } from "@/lib/fonts/amber";
import {
  type LatestValue,
  getNumericValue,
  getStringValue,
  descriptorToPriceLevel,
  getPriceLevel,
  getPriceLevelLabel,
  getPriceLevelGradient,
  getSummaryMessage,
} from "@/lib/amber-utils";
import { SunIcon, DiamondIcon } from "@/lib/amber-icons";

interface AmberNowProps {
  /**
   * Latest values from KV cache, keyed by logical path
   * Expected paths:
   * - bidi.grid.import/rate (number, c/kWh)
   * - bidi.grid.export/rate (number, c/kWh)
   * - bidi.grid.renewables/proportion (number, %)
   * - bidi.grid.import/descriptor (string, price level)
   * - bidi.grid.tariff/code (string)
   * - bidi.grid.interval/start (number, ms)
   * - bidi.grid.interval/end (number, ms)
   */
  latest: Record<string, LatestValue | null> | null;
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
  const summaryMessage = getSummaryMessage(priceLevel, renewables);
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
            <SunIcon className="w-5 h-5" />
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
