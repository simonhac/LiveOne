"use client";

import { useRef, useState, useEffect } from "react";
import Value from "@/components/ui/value";
import { Zap } from "lucide-react";
import TileSurface from "@/components/ui/tile-surface";
import TrendRow from "@/components/ui/trend-row";
import { TILE_CHIP, TILE_RING } from "@/lib/tile-style";
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
 * Drawn on the shared tile surface (docs/architecture/tile-style.md): the brand mark sits in the
 * title slot and the price disc keeps its brand gradient — it IS the data. From 180px it is a ring
 * tile like Battery and EV: the disc at the shared `TILE_RING` size, then one bottom row of feed-in
 * and renewables. Narrower, feed-in is a small chip bottom-right and renewables is not shown.
 *
 * TWO forms, because the tile grid only ever makes two (see `tile-grid.ts`: never fewer than 2
 * columns at a 176px minimum, so a tile is ~150–280px, or the whole section when it is alone):
 * | Width  | Height | Disc D            | Logo      | Feed-in           | Renewables |
 * |--------|--------|-------------------|-----------|-------------------|------------|
 * | 150px+ | 110px  | 93                | LogoMark  | chip bottom-right | —          |
 * | 180px+ | 180px  | 108 (`TILE_RING`) | Full logo | bottom row        | bottom row |
 */
export default function AmberSmallCard({ latest }: AmberSmallCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const [showDebug, setShowDebug] = useState(false);

  // Show debug indicator only when ?debug is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setShowDebug(params.has("debug"));
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
  const feedInValue = showFeedIn ? (
    <Value
      value={`${feedInPrice < 0 ? "" : "-"}${Math.abs(Math.round(feedInPrice))}`}
      unit="¢"
    />
  ) : null;

  return (
    <TileSurface
      rootRef={containerRef}
      className="min-w-[66px] self-stretch"
      surfaceClassName="min-h-[110px] @[180px]:min-h-[180px]"
    >
      {/* DEBUG: Container size indicator - only shown when ?debug is in URL */}
      {showDebug && (
        <div className="absolute top-0 right-0 bg-red-500 text-white text-[10px] px-1 rounded-bl z-50">
          {containerSize.width}w {containerSize.height}h
        </div>
      )}

      {/* Compact layout - shown when card < 180px */}
      <div className="@[180px]:hidden h-full flex flex-col">
        {/* Logo mark - absolute positioned top left */}
        <AmberLogoMark className="absolute top-3 left-3 h-4 w-4" />
        {/* Price circle - centered horizontally and vertically */}
        <div className="flex-1 flex items-center justify-center">
          <div
            className="w-[93px] h-[93px] rounded-full flex flex-col items-center justify-center"
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
              <Value value={Math.round(importPrice)} unit="¢" />
            </div>
            <div className="text-[7px]" style={{ color: "rgb(0, 0, 0)" }}>
              /kWh
            </div>
          </div>
        </div>
      </div>

      {/* Compact feed-in, bottom-right: the sun in a grey disc, then the price. From 180px it is a
          row instead. */}
      {showFeedIn && (
        <div className="absolute bottom-2 right-2 flex @[180px]:hidden items-center gap-1">
          <span className={`${TILE_CHIP} !size-5`}>
            <SunIcon className="w-3 h-3" />
          </span>
          <span className="text-white text-[11px] font-bold">
            {feedInValue}
          </span>
        </div>
      )}

      {/* Full layout - shown when card ≥ 180px */}
      <div className="hidden @[180px]:flex h-full flex-col">
        {/* The brand mark in the title slot — in flow, so the disc below can never slide under it. */}
        <div className="flex min-h-7 items-center">
          <AmberLogo className="h-5 w-auto" />
        </div>

        {/* Price disc - centred in the free height, at the shared ring size. */}
        <div className="flex-1 flex items-center justify-center py-2">
          <div
            className={`${TILE_RING} rounded-full flex flex-col items-center justify-center`}
            style={{ background: circleGradient }}
          >
            <Zap
              className="w-3 h-3 mb-0.5"
              style={{ color: "rgb(0, 11, 36)" }}
              fill="rgb(0, 11, 36)"
            />
            <div
              className="text-center text-[9px] font-bold mb-0.5"
              style={{ color: "rgb(0, 0, 0)" }}
            >
              {getPriceLevelShortLabel(priceLevel)}
            </div>
            <div
              className="font-bold leading-none text-[28px]"
              style={{ color: "rgb(0, 11, 36)" }}
            >
              <Value value={Math.round(importPrice)} unit="¢" />
            </div>
            <div className="text-[10px]" style={{ color: "rgb(0, 0, 0)" }}>
              /kWh
            </div>
          </div>
        </div>

        {/* One bottom row, as on Battery: feed-in with its chip, renewables beside it. */}
        {(showFeedIn || renewables !== null) && (
          <div className="flex items-end justify-between gap-3">
            {showFeedIn ? (
              <TrendRow
                // The chip waits for 220px: at 180 it squeezes "Feed-in" to "Fe…" beside Renewables.
                chip={
                  <span className={`${TILE_CHIP} !hidden @[220px]:!grid`}>
                    <SunIcon className="w-3.5 h-3.5" />
                  </span>
                }
                label="Feed-in"
                value={feedInValue}
              />
            ) : (
              <span />
            )}
            {renewables !== null && (
              <div className="shrink-0">
                <TrendRow
                  label="Renewables"
                  value={<Value value={Math.round(renewables)} unit="%" />}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </TileSurface>
  );
}
