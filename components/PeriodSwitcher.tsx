"use client";

import type { ChartTimeRange } from "@/lib/charts/scaffold";

const DEFAULT_PERIODS: readonly ChartTimeRange[] = ["D", "W", "M", "Y"];

interface PeriodSwitcherProps {
  value: ChartTimeRange;
  onChange: (value: ChartTimeRange) => void;
  /** Periods to offer, one button each (default the D/W/M/Y set). */
  periods?: readonly ChartTimeRange[];
  className?: string;
}

export default function PeriodSwitcher({
  value,
  onChange,
  periods = DEFAULT_PERIODS,
  className = "",
}: PeriodSwitcherProps) {
  return (
    <div
      className={`inline-flex rounded-md shadow-sm ${className}`}
      role="group"
    >
      {periods.map((period, index) => (
        <button
          key={period}
          onClick={() => onChange(period)}
          className={`
            px-3 py-1 text-xs font-medium transition-colors border
            ${index === 0 ? "rounded-l-md" : "-ml-px"}
            ${index === periods.length - 1 ? "rounded-r-md" : ""}
            ${
              value === period
                ? "bg-blue-900/50 text-blue-300 border-blue-800 z-10"
                : "bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300"
            }
          `}
        >
          {period}
        </button>
      ))}
    </div>
  );
}
