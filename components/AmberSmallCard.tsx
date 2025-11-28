"use client";

import { Zap } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import {
  type LatestValue,
  getNumericValue,
  getStringValue,
  descriptorToPriceLevel,
  getPriceLevel,
  getPriceLevelLabel,
  getPriceLevelGradient,
} from "@/lib/amber-utils";
import { SunIcon, AmberLogo } from "@/lib/amber-icons";

interface AmberSmallCardProps {
  /**
   * Latest values from KV cache, keyed by logical path
   */
  latest: Record<string, LatestValue | null> | null;
}

/**
 * Compact Amber pricing card - displays live price data in a card format
 * similar to the power cards (Solar, Load, Battery, Grid)
 */
export default function AmberSmallCard({ latest }: AmberSmallCardProps) {
  // Extract values from latest store
  const importPrice = getNumericValue(latest, "bidi.grid.import/rate");
  const feedInPrice = getNumericValue(latest, "bidi.grid.export/rate");
  const renewables = getNumericValue(latest, "bidi.grid.renewables/proportion");
  const descriptor = getStringValue(latest, "bidi.grid.import/descriptor");

  // Determine price level from descriptor or fall back to price-based calculation
  const priceLevel = descriptor
    ? descriptorToPriceLevel(descriptor)
    : getPriceLevel(importPrice);

  // Don't render if no data available
  if (importPrice === null) {
    return null;
  }

  const priceLevelLabel = getPriceLevelLabel(priceLevel);
  const circleGradient = getPriceLevelGradient(priceLevel);
  const showFeedIn = feedInPrice !== null;

  return (
    <div
      className={`bg-gray-800/50 border border-gray-700 rounded-lg p-2 md:p-4 ${ttInterphases.className}`}
    >
      {/* Header with Amber logo */}
      <div className="flex items-center gap-2 mb-3">
        <AmberLogo className="h-5 w-auto" />
      </div>

      {/* Main content: price circle + feed-in */}
      <div className="flex items-end gap-4">
        {/* Price circle */}
        <div
          className="rounded-full flex flex-col items-center justify-center flex-shrink-0"
          style={{
            background: circleGradient,
            width: "140px",
            height: "140px",
          }}
        >
          {/* Lightning icon */}
          <Zap
            className="w-4 h-4 mb-0.5"
            style={{ color: "rgb(0, 11, 36)" }}
            fill="rgb(0, 11, 36)"
          />

          {/* Price level label */}
          <div
            className="text-center text-[10px] font-bold mb-0.5"
            style={{ color: "rgb(0, 0, 0)" }}
          >
            {priceLevelLabel}
          </div>

          {/* Large price */}
          <div
            className="font-bold leading-none"
            style={{
              color: "rgb(0, 11, 36)",
              fontSize: "36px",
            }}
          >
            {Math.round(importPrice)}¢
          </div>
          <div className="text-[10px]" style={{ color: "rgb(0, 0, 0)" }}>
            /kWh
          </div>

          {/* Renewables percentage */}
          {renewables !== null && (
            <div className="text-center mt-1">
              <span
                className="font-bold"
                style={{
                  color: "rgb(0, 0, 0)",
                  fontSize: "16px",
                }}
              >
                {Math.round(renewables)}%
              </span>
              <div className="text-[8px]" style={{ color: "rgb(0, 0, 0)" }}>
                renewables in grid
              </div>
            </div>
          )}
        </div>

        {/* Feed-in section - right side, bottom aligned, smaller */}
        {showFeedIn && (
          <div className="flex flex-col items-center pb-1">
            <SunIcon className="w-4 h-4 mb-0.5" />
            <div className="font-bold text-white" style={{ fontSize: "14px" }}>
              {feedInPrice < 0 ? "" : "-"}
              {Math.abs(Math.round(feedInPrice))}¢
            </div>
            <div className="text-gray-500 text-[10px]">/kWh</div>
          </div>
        )}
      </div>
    </div>
  );
}
