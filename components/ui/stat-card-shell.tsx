"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Clock } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";

export interface StatCardShellProps {
  /** Lead glyph, sized by the caller (`<Battery size={16} />`). */
  icon: React.ReactNode;
  iconColor?: string;
  title: string;
  /** Muted text immediately after the title — e.g. the period ("24 hours"). */
  titleSuffix?: string;
  /** Newest contributing reading; absent ⇒ treated as permanently stale (no chrome, no tooltip). */
  measurementTime?: Date;
  staleThresholdSeconds?: number;
  children: React.ReactNode;
}

/**
 * The chrome shared by the labelled-stat cards (battery contents, home energy): the `@container`
 * panel, the header row (icon · title · period), and the staleness treatment — dim + a diagonal
 * hatch once the newest reading is older than the threshold, with a `Clock` whose portal tooltip
 * spells out the last update.
 *
 * Extracted from BatteryContentsCard, which had grown its own copy of what `Tile` already did.
 * `Tile` keeps its own (its header is a different shape: icon right on desktop, hero value, extras).
 * Body content is the caller's — this owns only the frame.
 */
export default function StatCardShell({
  icon,
  iconColor = "text-green-400",
  title,
  titleSuffix,
  measurementTime,
  staleThresholdSeconds = 900,
  children,
}: StatCardShellProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const clockIconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const newestMs = measurementTime ? measurementTime.getTime() : null;
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
        <div className="mb-2 flex items-center gap-1.5">
          <span className={`flex-shrink-0 ${iconColor}`}>{icon}</span>
          <span className="truncate text-xs text-gray-300 md:text-sm">
            {title}
          </span>
          {titleSuffix && (
            <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-gray-500 md:text-xs">
              {titleSuffix}
            </span>
          )}
          {isStale && newestMs !== null && (
            <>
              <div
                ref={clockIconRef}
                onMouseEnter={handleClockMouseEnter}
                onMouseLeave={() => setIsTooltipVisible(false)}
                className="flex-shrink-0 cursor-help text-gray-500"
              >
                <Clock size={12} className="md:w-[14px] md:h-[14px]" />
              </div>
              {isTooltipVisible &&
                typeof document !== "undefined" &&
                createPortal(
                  <div
                    className="fixed z-[9999] whitespace-nowrap rounded-lg border border-gray-700 bg-black px-3 py-2 text-xs text-white shadow-xl pointer-events-none"
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
        {children}
      </div>
    </div>
  );
}

/** Time first, date appended only when the reading isn't from today. */
function formatTooltipDate(date: Date): string {
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
}
