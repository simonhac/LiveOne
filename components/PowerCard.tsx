import React, { useState, useRef } from "react";
import { Clock } from "lucide-react";

interface PowerCardProps {
  title: string;
  value: string;
  icon: React.ReactNode;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  secondsSinceUpdate?: number;
  staleThresholdSeconds: number;
  measurementTime?: Date;
  extraInfo?: string;
  extra?: React.ReactNode;
}

export default function PowerCard({
  title,
  value,
  icon,
  iconColor,
  bgColor,
  borderColor,
  secondsSinceUpdate = 0,
  staleThresholdSeconds,
  measurementTime,
  extraInfo,
  extra,
}: PowerCardProps) {
  const isStale = secondsSinceUpdate > staleThresholdSeconds;
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const clockIconRef = useRef<HTMLDivElement>(null);

  const handleClockMouseEnter = () => {
    if (clockIconRef.current) {
      const rect = clockIconRef.current.getBoundingClientRect();
      setTooltipPosition({
        x: rect.left,
        y: rect.bottom + 8,
      });
    }
    setIsTooltipVisible(true);
  };

  return (
    <div
      className={`${bgColor} border ${borderColor} rounded-lg p-4 relative overflow-hidden ${isStale ? "opacity-75" : ""}`}
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
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-gray-400 text-sm">{title}</span>
            {isStale && measurementTime && (
              <>
                <div
                  ref={clockIconRef}
                  onMouseEnter={handleClockMouseEnter}
                  onMouseLeave={() => setIsTooltipVisible(false)}
                  className="text-gray-500 cursor-help"
                >
                  <Clock size={14} />
                </div>
                {isTooltipVisible && (
                  <div
                    className="fixed z-[100] bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 shadow-lg text-xs text-gray-300 whitespace-nowrap"
                    style={{
                      left: `${tooltipPosition.x}px`,
                      top: `${tooltipPosition.y}px`,
                    }}
                  >
                    Last update:{" "}
                    {measurementTime.toLocaleString("en-AU", {
                      timeZone: "Australia/Sydney",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </div>
                )}
              </>
            )}
          </div>
          <div className={iconColor}>{icon}</div>
        </div>
        <p className="text-2xl font-bold text-white">{value}</p>
        {extraInfo && <p className="text-xs text-gray-500 mt-1">{extraInfo}</p>}
        {extra && <div className="mt-2">{extra}</div>}
      </div>
    </div>
  );
}
