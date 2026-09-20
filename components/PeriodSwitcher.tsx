"use client";

import type { ChartTimeRange } from "@/lib/charts/temporal";
import {
  SEGMENTED_ITEM,
  SEGMENTED_ITEM_OFF,
  SEGMENTED_ITEM_ON,
  SEGMENTED_TRACK,
} from "@/components/ui/segmented";

const DEFAULT_PERIODS: readonly ChartTimeRange[] = ["D", "W", "M", "Y"];

interface PeriodSwitcherProps {
  value: ChartTimeRange;
  onChange: (value: ChartTimeRange) => void;
  /** Periods to offer, one segment each (default the D/W/M/Y set). */
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
    <div className={`${SEGMENTED_TRACK} ${className}`} role="group">
      {periods.map((period) => (
        <button
          key={period}
          onClick={() => onChange(period)}
          aria-pressed={value === period}
          className={`${SEGMENTED_ITEM} ${
            value === period ? SEGMENTED_ITEM_ON : SEGMENTED_ITEM_OFF
          }`}
        >
          {period}
        </button>
      ))}
    </div>
  );
}
