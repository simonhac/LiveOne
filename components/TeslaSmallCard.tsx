"use client";

import { useRef, useState, useEffect } from "react";
import Value from "@/components/ui/value";
import ProgressRing from "@/components/ui/progress-ring";
import {
  Battery,
  BatteryCharging,
  ChevronLeft,
  ChevronsLeft,
  Settings,
} from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import { TeslaMark } from "@/lib/tesla-icons";
import { getEvStatus, getEvStatusWords } from "@/lib/vendors/tesla/status";
import TeslaControlDialog from "@/components/TeslaControlDialog";

interface LatestValue {
  value: number | string | boolean;
  measurementTime?: Date;
  metricUnit?: string;
  displayName?: string;
}

interface TeslaSmallCardProps {
  /**
   * Latest values from KV cache, keyed by logical path
   */
  latest: Record<string, LatestValue | null> | null;
  /** Device id — required to enable the charge-control dialog. */
  systemId?: number;
  /** Whether the current user may issue charge commands (owner or admin). */
  canControl?: boolean;
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
 * Get a boolean value from latest values store.
 *
 * Boolean points round-trip through KV as 1/0 — `convertValueByMetadata` only
 * special-cases `metricUnit === "text"`, so everything else is stored numeric.
 */
function getBooleanValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): boolean | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "boolean") return point.value;
  if (typeof point.value === "number") return point.value !== 0;
  if (typeof point.value === "string")
    return point.value === "true" || point.value === "1";
  return null;
}

/**
 * Format hours to "Xh Ym" format
 */
function formatTimeRemaining(hours: number): string {
  if (hours <= 0) return "";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

/**
 * Get battery fill color based on SoC level
 */
function getBatteryColor(soc: number): string {
  if (soc <= 20) return "#ef4444"; // red-500
  if (soc <= 40) return "#f97316"; // orange-500
  if (soc <= 60) return "#eab308"; // yellow-500
  return "#22c55e"; // green-500
}

/**
 * Compact Tesla card - SoC donut plus the car's state.
 *
 * One layout throughout; container queries (card width, never the viewport) do
 * all the scaling. The donut diameters match AmberSmallCard's disc at every
 * step so the two tiles line up side by side.
 *
 * | Width    | Height | Padding | Donut D | Mark   | Chevron | Status Text        |
 * |----------|--------|---------|---------|--------|---------|--------------------|
 * | 66px min | 110px  | 8px     | 75      | Hidden | Hidden  | 9px, state only    |
 * | 90px+    | 110px  | 8px     | 75      | 16px   | 16px    | 9px, state only    |
 * | 120px+   | 110px  | 8px     | 85      | 16px   | 16px    | 10px, state only   |
 * | 180px+   | 180px  | 12px    | 140     | 20px   | 20px    | 12px, state only   |
 * | 260px+   | 180px  | 12px    | 140     | 20px   | 20px    | 12px + 10px detail |
 *
 * The charging detail (kW, ETA) waits for 260px because below that it cannot
 * clear the 140px donut in the corner it shares with it.
 */
export default function TeslaSmallCard({
  latest,
  systemId,
  canControl,
}: TeslaSmallCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const [showDebug, setShowDebug] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);

  const showControls = canControl && systemId != null;

  // Show debug indicator only when ?debug is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setShowDebug(params.has("debug"));
  }, []);

  // Track container size for debugging
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
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
  const batterySoc = getNumericValue(latest, "ev.battery/soc");
  const chargingState = getStringValue(latest, "ev.charge/state");
  const chargePower = getNumericValue(latest, "ev.charge/power");
  const timeToFull = getNumericValue(latest, "ev.charge/remaining");
  const chargeLimit = getNumericValue(latest, "ev.charge.limit/soc");
  const shift = getStringValue(latest, "ev/shift");
  const pluggedIn = getBooleanValue(latest, "ev.charge/engaged");

  // Don't render if no data available
  if (batterySoc === null) {
    return null;
  }

  const status = getEvStatus({ shift, chargingState, pluggedIn });
  const statusWords = getEvStatusWords(status);
  const isCharging = status === "charging";
  const batteryColor = getBatteryColor(batterySoc);

  // Charging detail: power fuses onto the state line, the ETA gets its own.
  const powerText =
    isCharging && chargePower !== null ? `${chargePower} kW` : null;
  const etaText =
    isCharging && timeToFull
      ? `${formatTimeRemaining(timeToFull)} to ${chargeLimit ? `${Math.round(chargeLimit)}%` : "full"}`
      : null;

  // Determine if we should show double chevrons (high power charging)
  const isHighPower = chargePower !== null && chargePower > 10;

  return (
    <div
      ref={containerRef}
      className={`@container relative bg-gray-800/50 border border-gray-700 rounded-lg p-2 @[180px]:p-3 min-h-[110px] @[180px]:min-h-[180px] min-w-[66px] self-stretch ${ttInterphases.className}`}
    >
      {/* DEBUG: Container size indicator */}
      {showDebug && (
        <div className="absolute top-0 right-0 bg-red-500 text-white text-[10px] px-1 rounded-bl z-50">
          {containerSize.width}w {containerSize.height}h
        </div>
      )}

      {/* Charge-control cog — owner/admin only, shown once the card is wide enough */}
      {showControls && (
        <button
          type="button"
          onClick={() => setControlsOpen(true)}
          aria-label="Charging controls"
          className="hidden @[120px]:flex absolute top-2 right-2 z-40 items-center justify-center text-gray-500 hover:text-gray-200 transition-colors"
        >
          <Settings className="w-4 h-4 @[180px]:w-[18px] @[180px]:h-[18px]" />
        </button>
      )}

      {showControls && (
        <TeslaControlDialog
          systemId={systemId as number}
          open={controlsOpen}
          onOpenChange={setControlsOpen}
          latest={latest}
        />
      )}

      {/* Tesla mark with charging chevrons - absolute positioned top left */}
      <div className="absolute top-2 left-2 @[180px]:top-3 @[180px]:left-3 hidden @[90px]:flex items-center">
        <TeslaMark className="w-4 h-4 @[180px]:w-5 @[180px]:h-5 text-white" />
        {isCharging && (
          <span style={{ color: batteryColor }}>
            {isHighPower ? (
              <ChevronsLeft className="w-4 h-4 @[180px]:w-5 @[180px]:h-5" />
            ) : (
              <ChevronLeft className="w-4 h-4 @[180px]:w-5 @[180px]:h-5" />
            )}
          </span>
        )}
      </div>

      {/* SoC donut - centred in the full card height */}
      <div className="h-full flex items-center justify-center">
        <ProgressRing
          fraction={batterySoc / 100}
          color={batteryColor}
          className="w-[75px] h-[75px] @[120px]:w-[85px] @[120px]:h-[85px] @[180px]:w-[140px] @[180px]:h-[140px] rounded-full bg-gray-700/50"
        >
          {isCharging ? (
            <BatteryCharging
              className="w-4 h-4 @[180px]:w-6 @[180px]:h-6 mb-1"
              style={{ color: batteryColor }}
            />
          ) : (
            <Battery
              className="w-4 h-4 @[180px]:w-6 @[180px]:h-6 mb-1"
              style={{ color: batteryColor }}
            />
          )}
          <div className="font-bold leading-none text-[22px] @[180px]:text-[36px] text-white">
            <Value value={Math.round(batterySoc)} unit="%" />
          </div>
          <div className="hidden @[180px]:block text-gray-400 text-xs mt-1">
            Battery
          </div>
        </ProgressRing>
      </div>

      {/* Status - bottom right, one word per line so the donut keeps the height.
          It sits in the corner the donut leaves free, so it hugs the very edge
          and the charging detail waits for a card wide enough to hold it. */}
      <div className="absolute bottom-1.5 right-1.5 @[180px]:bottom-2 @[180px]:right-2 text-right leading-tight text-gray-400 text-[9px] @[120px]:text-[10px] @[180px]:text-xs">
        {statusWords.map((word, i) => (
          <div key={word}>
            {word}
            {/* Power fuses onto the last state word, a size down so the pair
                still clears the donut on the narrowest card that shows it */}
            {powerText && i === statusWords.length - 1 && (
              <span className="hidden @[260px]:inline text-[10px]">
                {" "}
                {powerText}
              </span>
            )}
          </div>
        ))}
        {etaText && (
          <div className="hidden @[260px]:block text-[10px] text-gray-500">
            {etaText}
          </div>
        )}
      </div>
    </div>
  );
}
