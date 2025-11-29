import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Clock } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";

interface PowerCardProps {
  title: string;
  value: string;
  /** Unit to display after value (e.g., "kW", "%"). Rendered smaller with appropriate spacing. */
  unit?: string;
  icon: React.ReactNode;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  staleThresholdSeconds: number;
  measurementTime?: Date;
  extraInfo?: string;
  extra?: React.ReactNode;
}

export default function PowerCard({
  title,
  value,
  unit,
  icon,
  iconColor,
  bgColor,
  borderColor,
  staleThresholdSeconds,
  measurementTime,
  extraInfo,
  extra,
}: PowerCardProps) {
  const [isStale, setIsStale] = useState(false);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const clockIconRef = useRef<HTMLDivElement>(null);

  // Re-evaluate staleness every second, but only re-render if staleness changes
  useEffect(() => {
    const checkStaleness = () => {
      const secondsSinceUpdate = measurementTime
        ? Math.floor((Date.now() - measurementTime.getTime()) / 1000)
        : Infinity;
      const nowStale = secondsSinceUpdate > staleThresholdSeconds;

      // Only update state if staleness actually changed
      setIsStale((prevStale) => {
        if (prevStale !== nowStale) {
          return nowStale;
        }
        return prevStale;
      });
    };

    // Check immediately
    checkStaleness();

    // Then check every second
    const interval = setInterval(checkStaleness, 1000);

    return () => clearInterval(interval);
  }, [measurementTime, staleThresholdSeconds]);

  const handleClockMouseEnter = () => {
    if (clockIconRef.current) {
      const rect = clockIconRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;

      // Position tooltip, ensuring it doesn't go offscreen
      let x = rect.left;
      let y = rect.bottom + 8;

      // Rough estimate: tooltip is about 200px wide
      if (x + 200 > viewportWidth) {
        x = viewportWidth - 210; // 200px width + 10px margin
      }

      setTooltipPosition({ x, y });
    }
    setIsTooltipVisible(true);
  };

  // Format tooltip date: show time first, omit date if today
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

  return (
    <div
      className={`${bgColor} border ${borderColor} rounded-lg p-2 md:p-4 relative overflow-hidden min-h-[110px] md:min-h-0 ${isStale ? "opacity-75" : ""} ${ttInterphases.className}`}
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
        {/* Mobile: horizontal layout (icon left of title), Desktop: vertical (icon right) */}
        <div className="flex items-start md:items-center md:justify-between mb-0.5 gap-1.5">
          {/* Icon on left for mobile */}
          <div
            className={`${iconColor} md:hidden flex-shrink-0 [&_svg]:w-4 [&_svg]:h-4`}
          >
            {icon}
          </div>

          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <span className="text-gray-400 text-xs md:text-sm truncate">
              {title}
            </span>
            {isStale && measurementTime && (
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
                      Last update: {formatTooltipDate(measurementTime)}
                    </div>,
                    document.body,
                  )}
              </>
            )}
          </div>

          {/* Icon on right for desktop */}
          <div className={`${iconColor} hidden md:block flex-shrink-0`}>
            {icon}
          </div>
        </div>
        <p className="text-xl md:text-2xl font-bold text-gray-200">
          {value}
          {unit && (
            <>
              {unit !== "%" && "\u202F"}
              <span className="text-sm md:text-base font-semibold">{unit}</span>
            </>
          )}
        </p>
        {extraInfo && <p className="text-xs text-gray-400">{extraInfo}</p>}
        {extra && <div className="mt-0.5 md:mt-1">{extra}</div>}
      </div>
    </div>
  );
}
