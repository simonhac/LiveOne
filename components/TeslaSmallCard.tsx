"use client";

import { useRef, useState, useEffect } from "react";
import Image from "next/image";
import {
  Battery,
  BatteryCharging,
  ChevronLeft,
  ChevronsLeft,
} from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";

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
 * Compact Tesla card - displays battery state and charging info
 *
 * Container Query Breakpoints (all based on card width, no viewport breakpoints):
 * | Width    | Height | Padding | Circle D | Logo     | Chevron | Status Text |
 * |----------|--------|---------|----------|----------|---------|-------------|
 * | 66px min | 110px  | 8px     | 70       | Hidden   | Hidden  | 9px         |
 * | 90px+    | 110px  | 8px     | 70       | 36px     | 16px    | 9px         |
 * | 120px+   | 110px  | 8px     | 80       | 36px     | 16px    | 10px        |
 * | 180px+   | 180px  | 12px    | 120      | 45px     | 20px    | 14px (sm)   |
 */
export default function TeslaSmallCard({ latest }: TeslaSmallCardProps) {
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

  // Don't render if no data available
  if (batterySoc === null) {
    return null;
  }

  const isCharging = chargingState === "Charging";
  const batteryColor = getBatteryColor(batterySoc);

  // Build charging status string
  let chargingStatus = "Not Charging";
  if (isCharging && chargePower !== null) {
    const limitStr = chargeLimit ? `${Math.round(chargeLimit)}%` : "full";
    const timeStr = timeToFull
      ? `${formatTimeRemaining(timeToFull)} to ${limitStr}`
      : "";
    chargingStatus = timeStr
      ? `Charging at ${chargePower} kW — ${timeStr}`
      : `Charging at ${chargePower} kW`;
  }

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

      {/* Compact layout - shown when card < 180px */}
      <div className="@[180px]:hidden h-full flex flex-col">
        {/* Tesla logo with charging chevrons - absolute positioned top left */}
        <div className="absolute top-2 left-2 hidden @[90px]:flex items-center">
          <Image
            src="/icons/tesla-logo.png"
            alt="Tesla"
            width={36}
            height={36}
            className="opacity-60"
          />
          {isCharging && (
            <span style={{ color: "#892D39" }}>
              {isHighPower ? (
                <ChevronsLeft className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </span>
          )}
        </div>

        {/* Battery circle - centered */}
        <div className="flex-1 flex items-center justify-center">
          <div
            className="w-[70px] h-[70px] @[120px]:w-[80px] @[120px]:h-[80px] rounded-full flex flex-col items-center justify-center bg-gray-700/50 border-2"
            style={{ borderColor: batteryColor }}
          >
            {isCharging ? (
              <BatteryCharging
                className="w-5 h-5 mb-1"
                style={{ color: batteryColor }}
              />
            ) : (
              <Battery
                className="w-5 h-5 mb-1"
                style={{ color: batteryColor }}
              />
            )}
            <div className="font-bold leading-none text-[22px] text-white">
              {Math.round(batterySoc)}%
            </div>
          </div>
        </div>
      </div>

      {/* Charging status at bottom - compact mode */}
      <div className="@[180px]:hidden absolute bottom-3 left-1.5 right-1.5 text-center">
        <span className="text-gray-400 text-[9px] @[120px]:text-[10px] truncate block">
          {chargingStatus}
        </span>
      </div>

      {/* Full layout - shown when card ≥ 180px */}
      <div className="hidden @[180px]:flex h-full flex-col">
        {/* Tesla logo with charging chevrons - absolute positioned top left */}
        <div className="absolute top-3 left-3 flex items-center">
          <Image
            src="/icons/tesla-logo.png"
            alt="Tesla"
            width={45}
            height={45}
            className="opacity-60"
          />
          {isCharging && (
            <span style={{ color: "#892D39" }}>
              {isHighPower ? (
                <ChevronsLeft className="w-5 h-5" />
              ) : (
                <ChevronLeft className="w-5 h-5" />
              )}
            </span>
          )}
        </div>

        {/* Battery circle - centered */}
        <div className="flex-1 flex items-center justify-center">
          <div
            className="w-[120px] h-[120px] rounded-full flex flex-col items-center justify-center bg-gray-700/50 border-4"
            style={{ borderColor: batteryColor }}
          >
            {isCharging ? (
              <BatteryCharging
                className="w-6 h-6 mb-1"
                style={{ color: batteryColor }}
              />
            ) : (
              <Battery
                className="w-6 h-6 mb-1"
                style={{ color: batteryColor }}
              />
            )}
            <div className="font-bold leading-none text-[32px] text-white">
              {Math.round(batterySoc)}%
            </div>
            <div className="text-gray-400 text-xs mt-1">Battery</div>
          </div>
        </div>

        {/* Charging status at bottom */}
        <div className="text-center pt-1.5 pb-1">
          <span className="text-gray-400 text-sm">{chargingStatus}</span>
        </div>
      </div>
    </div>
  );
}
