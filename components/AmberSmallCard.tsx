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
 * | Width    | Height | Padding | Circle D | Circle V | Logo      | Feed-in Pos | Sun  | Weight | /kWh    |
 * |----------|--------|---------|----------|----------|-----------|-------------|------|--------|---------|
 * | 66px min | 110px  | 8px     | 75       | Center   | Hidden    | 6px edges   | Hide | Medium | Hidden  |
 * | 90px+    | 110px  | 8px     | 75       | Center   | LogoMark  | 6px edges   | Show | Medium | Hidden  |
 * | 120px+   | 110px  | 8px     | 85       | Center   | LogoMark  | 8px edges   | Show | Bold   | Hidden  |
 * | 180px+   | 180px  | 12px    | 140      | Centre+20| Full logo | 10px edges  | Show | Bold   | Hidden  |
 * | 300px+   | 180px  | 12px    | 140      | Centre+20| Full logo | 10px edges  | Show | Bold   | Visible |
 */
export default function AmberSmallCard({ latest }: AmberSmallCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  // Detect if DevTools is open (works for docked DevTools)
  useEffect(() => {
    const checkDevTools = () => {
      const threshold = 160;
      const widthDiff = window.outerWidth - window.innerWidth > threshold;
      const heightDiff = window.outerHeight - window.innerHeight > threshold;
      setDevToolsOpen(widthDiff || heightDiff);
    };
    checkDevTools();
    window.addEventListener("resize", checkDevTools);
    return () => window.removeEventListener("resize", checkDevTools);
  }, []);

  // Track container size for debugging
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Set initial size (content-box to match container queries)
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const paddingX =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingY =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const borderX =
      parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const borderY =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    setContainerSize({
      width: Math.round(rect.width - paddingX - borderX),
      height: Math.round(rect.height - paddingY - borderY),
    });
    // Watch for changes
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use contentRect - this matches what container queries measure
        setContainerSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
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
      className={`@container relative bg-gray-800/50 border border-gray-700 rounded-lg p-2 @[180px]:p-3 min-h-[110px] @[180px]:min-h-[180px] min-w-[66px] self-stretch ${ttInterphases.className}`}
    >
      {/* DEBUG: Container size indicator - only shown when DevTools is open */}
      {devToolsOpen && (
        <div className="absolute top-0 right-0 bg-red-500 text-white text-[10px] px-1 rounded-bl z-50">
          {containerSize.width}w {containerSize.height}h
        </div>
      )}

      {/* Compact layout - shown when card < 180px */}
      <div className="@[180px]:hidden h-full flex flex-col">
        {/* Logo mark - absolute positioned top left */}
        <AmberLogoMark className="absolute top-2 left-2 h-4 w-4 hidden @[90px]:block" />
        {/* Price circle - centered horizontally and vertically */}
        <div className="flex-1 flex items-center justify-center">
          <div
            className="w-[75px] h-[75px] @[120px]:w-[85px] @[120px]:h-[85px] rounded-full flex flex-col items-center justify-center"
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
        <div className="absolute bottom-1.5 right-1.5 @[120px]:bottom-2 @[120px]:right-2 @[180px]:bottom-2.5 @[180px]:right-2.5 flex flex-col items-center">
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
      <div className="hidden @[180px]:flex h-full flex-col">
        {/* Amber logo - absolute positioned top left */}
        <AmberLogo className="absolute top-3 left-3 h-5 w-auto" />

        {/* Price circle - centered horizontally and vertically */}
        <div className="flex-1 flex items-center justify-center">
          <div
            className="w-[140px] h-[140px] rounded-full flex flex-col items-center justify-center mt-5"
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
    </div>
  );
}
