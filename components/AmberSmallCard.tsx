"use client";

import { useRef, useState, useEffect } from "react";
import { Zap } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import {
  type LatestValue,
  getNumericValue,
  getStringValue,
  descriptorToPriceLevel,
  getPriceLevel,
  getPriceLevelShortLabel,
  getPriceLevelGradient,
} from "@/lib/amber-utils";
import { SunIcon, AmberLogo, AmberLogoMark } from "@/lib/amber-icons";

interface AmberSmallCardProps {
  /**
   * Latest values from KV cache, keyed by logical path
   */
  latest: Record<string, LatestValue | null> | null;
}

/**
 * Compact Amber pricing card - displays live price data in a card format
 * similar to the power cards (Solar, Load, Battery, Grid)
 *
 * Container Query Breakpoints (all based on card width, no viewport breakpoints):
 * | Width    | Padding | Circle    | Logo      | Feed-in Pos | Sun  | Weight | /kWh    |
 * |----------|---------|-----------|-----------|-------------|------|--------|---------|
 * | 66px min | 8px     | 75×75px   | Hidden    | 6px edges   | Hide | Medium | Hidden  |
 * | 90px+    | 8px     | 75×75px   | LogoMark  | 6px edges   | Show | Medium | Hidden  |
 * | 120px+   | 8px     | 75×75px   | LogoMark  | 8px edges   | Show | Bold   | Hidden  |
 * | 180px+   | 16px    | 140×140px | Full logo | 12px edges  | Show | Bold   | Hidden  |
 * | 300px+   | 16px    | 140×140px | Full logo | 12px edges  | Show | Bold   | Visible |
 */
export default function AmberSmallCard({ latest }: AmberSmallCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  // Track container width for debugging
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Set initial width
    setContainerWidth(Math.round(el.getBoundingClientRect().width));
    // Watch for changes
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(Math.round(entry.contentRect.width));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  const circleGradient = getPriceLevelGradient(priceLevel);
  const showFeedIn = feedInPrice !== null;

  return (
    <div
      ref={containerRef}
      className={`@container relative bg-gray-800/50 border border-gray-700 rounded-lg p-2 @[180px]:p-4 min-h-[110px] @[180px]:min-h-0 min-w-[66px] ${ttInterphases.className}`}
    >
      {/* DEBUG: Container width indicator - uncomment for testing
      <div className="absolute top-0 right-0 bg-red-500 text-white text-[10px] px-1 rounded-bl z-50">
        {containerWidth}px
      </div>
      */}

      {/* Compact layout - shown when card < 180px */}
      <div className="@[180px]:hidden">
        {/* Header row: logo mark on left (like PowerCard) */}
        <div className="flex items-center gap-1.5 mb-1">
          <AmberLogoMark className="h-4 w-4 flex-shrink-0 hidden @[90px]:block" />
        </div>
        {/* Price circle - centered via flex container */}
        <div className="flex justify-center @[90px]:-mt-[15px]">
          <div
            className="w-[75px] h-[75px] rounded-full flex flex-col items-center justify-center"
            style={{ background: circleGradient }}
          >
            <Zap
              className="w-3 h-3"
              style={{ color: "rgb(0, 11, 36)" }}
              fill="rgb(0, 11, 36)"
            />
            <div
              className="text-center text-[7px] font-bold"
              style={{ color: "rgb(0, 0, 0)" }}
            >
              {getPriceLevelShortLabel(priceLevel)}
            </div>
            <div
              className="font-bold leading-none text-[22px]"
              style={{ color: "rgb(0, 11, 36)" }}
            >
              {Math.round(importPrice)}¢
            </div>
            <div className="text-[7px]" style={{ color: "rgb(0, 0, 0)" }}>
              /kWh
            </div>
          </div>
        </div>
      </div>

      {/* Feed-in at bottom right - all screen sizes */}
      {/* Container query: show /kWh only when card is >= 300px wide */}
      {showFeedIn && (
        <div className="absolute bottom-1.5 right-1.5 @[120px]:bottom-2 @[120px]:right-2 @[180px]:bottom-3 @[180px]:right-3 flex flex-col items-center">
          <SunIcon className="w-2.5 h-2.5 @[180px]:w-4 @[180px]:h-4 mb-0.5 hidden @[90px]:block" />
          <span className="text-white text-[10px] @[180px]:text-sm font-medium @[120px]:font-bold">
            {feedInPrice < 0 ? "" : "-"}
            {Math.abs(Math.round(feedInPrice))}¢
          </span>
          <span className="hidden @[300px]:block text-gray-500 text-[10px]">
            /kWh
          </span>
        </div>
      )}

      {/* Full layout - shown when card ≥ 180px */}
      <div className="hidden @[180px]:block">
        {/* Header with Amber logo */}
        <div className="flex items-center gap-2 mb-3">
          <AmberLogo className="h-5 w-auto" />
        </div>

        {/* Price circle - centered */}
        <div
          className="w-[140px] h-[140px] rounded-full flex flex-col items-center justify-center mx-auto"
          style={{ background: circleGradient }}
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
            {getPriceLevelShortLabel(priceLevel)}
          </div>

          {/* Large price */}
          <div
            className="font-bold leading-none text-[36px]"
            style={{ color: "rgb(0, 11, 36)" }}
          >
            {Math.round(importPrice)}¢
          </div>
          <div className="text-[10px]" style={{ color: "rgb(0, 0, 0)" }}>
            /kWh
          </div>

          {/* Renewables percentage */}
          {renewables !== null && (
            <div className="text-center -mt-0.5">
              <span
                className="font-bold block mt-[6px]"
                style={{
                  color: "rgb(0, 0, 0)",
                  fontSize: "16px",
                }}
              >
                {Math.round(renewables)}%
              </span>
              <div
                className="text-[8px] -mt-[4px]"
                style={{ color: "rgb(0, 0, 0)" }}
              >
                renewables
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
