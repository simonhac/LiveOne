"use client";

import { useMemo, useRef } from "react";
import { SeriesData } from "./MondoPowerChart";
import { calculateSeriesEnergy } from "@/lib/energy-calculator";

interface EnergyTableProps {
  chartData: {
    timestamps: Date[];
    series: SeriesData[];
    mode: "power" | "energy";
  } | null;
  mode: "load" | "generation";
  hoveredIndex?: number | null; // Index of the hovered data point
  className?: string;
  visibleSeries?: Set<string>; // Which series are visible
  onSeriesToggle?: (seriesId: string, shiftKey: boolean) => void; // Handle series visibility toggle
}

export default function EnergyTable({
  chartData,
  mode,
  hoveredIndex,
  className = "",
  visibleSeries,
  onSeriesToggle,
}: EnergyTableProps) {
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isPressedRef = useRef(false);
  const longPressHandledRef = useRef(false);

  // Calculate energy values for all series
  const energyValues = useMemo(() => {
    if (!chartData) return new Map<string, number | null>();
    return calculateSeriesEnergy(chartData.series, chartData.timestamps);
  }, [chartData]);

  if (!chartData || chartData.series.length === 0) {
    return (
      <div className={`${className}`}>
        <div className="text-gray-500 text-center">No data</div>
      </div>
    );
  }

  const isHovering = hoveredIndex !== null && hoveredIndex !== undefined;

  // Use hovered index if available, otherwise use the latest
  const dataIndex = isHovering ? hoveredIndex : chartData.timestamps.length - 1;

  // Build table data from series - maintain consistent order from chart
  const tableData = chartData.series.map((series) => {
    const isVisible = !visibleSeries || visibleSeries.has(series.id);
    return {
      id: series.id,
      label: series.description,
      powerValue: series.data[dataIndex], // Power value at specific point (kW)
      energyValue: energyValues.get(series.id) ?? null, // Total energy (kWh)
      color: series.color,
      isVisible,
    };
  });
  // Keep the original order from the chart configuration - no sorting

  // Calculate totals (only include visible series)
  let powerTotal: number | null = null;
  let energyTotal: number | null = null;
  let hasAnyValue = false;

  tableData.forEach((item) => {
    // Only include in totals if the series is visible
    if (item.isVisible) {
      // Power total
      if (item.powerValue !== null && item.powerValue !== undefined) {
        hasAnyValue = true;
        powerTotal = (powerTotal ?? 0) + item.powerValue;
      }
      // Energy total
      if (item.energyValue !== null && item.energyValue !== undefined) {
        energyTotal = (energyTotal ?? 0) + item.energyValue;
      }
    }
  });

  // If all values are null, total should be null
  if (!hasAnyValue) {
    powerTotal = null;
  }

  const formatValue = (
    value: number | null | undefined,
    decimals: number = 1,
  ) => {
    if (value === null || value === undefined) return "—"; // Show dash for no data
    return value.toFixed(decimals);
  };

  const formatPercentage = (
    value: number | null | undefined,
    total: number | null,
  ) => {
    if (value === null || value === undefined || total === null || total === 0)
      return "—";
    const percentage = (value / total) * 100;
    return percentage.toFixed(0) + "%";
  };

  // Decide which values to show based on hover state
  const displayValue = isHovering ? "power" : "energy";
  const columnHeader = isHovering ? "Power (kW)" : "Energy (kWh)";
  const total = isHovering ? powerTotal : energyTotal;

  // Handle touch and click events for series toggle
  const handlePointerDown = (seriesId: string) => {
    isPressedRef.current = true;
    longPressHandledRef.current = false;

    // Start timer for long press (500ms)
    longPressTimerRef.current = setTimeout(() => {
      if (isPressedRef.current) {
        // Long press detected - act as shift-click (select only)
        onSeriesToggle?.(seriesId, true);
        isPressedRef.current = false;
        longPressHandledRef.current = true; // Mark that we handled the long press
      }
    }, 500);
  };

  const handlePointerUp = (
    seriesId: string,
    e: React.MouseEvent | React.TouchEvent,
  ) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // Only handle normal click if we didn't just handle a long press
    if (isPressedRef.current && !longPressHandledRef.current) {
      // Normal click/tap
      const isShiftClick = "shiftKey" in e ? e.shiftKey : false;
      onSeriesToggle?.(seriesId, isShiftClick);
    }

    isPressedRef.current = false;
    longPressHandledRef.current = false;
  };

  const handlePointerCancel = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    isPressedRef.current = false;
    longPressHandledRef.current = false;
  };

  return (
    <div className={`${className}`}>
      {/* Match exact chart title height (text-sm = ~20px) + margin (mb-3 = 12px) + chart padding (~12px) */}
      <div className="space-y-4" style={{ paddingTop: "44px" }}>
        {/* Column Headers - aligned to top */}
        <div className="flex items-center text-xs border-b border-gray-700 pb-1">
          <div className="flex-1 text-gray-400">
            {mode === "load" ? "Load" : "Source"}
          </div>
          <div className="w-20 text-right text-gray-400">{columnHeader}</div>
          <div className="w-12 text-right text-gray-400">%</div>
        </div>

        {/* Items */}
        <div className="space-y-1">
          {tableData.map((item) => {
            return (
              <div key={item.label} className="flex items-center text-xs">
                <div
                  className="flex items-center gap-2 flex-1 cursor-pointer select-none"
                  onMouseDown={() => handlePointerDown(item.id)}
                  onMouseUp={(e) => handlePointerUp(item.id, e)}
                  onMouseLeave={handlePointerCancel}
                  onTouchStart={() => handlePointerDown(item.id)}
                  onTouchEnd={(e) => handlePointerUp(item.id, e)}
                  onTouchCancel={handlePointerCancel}
                  title="Click to toggle visibility, Shift-click or long press to show only this series"
                >
                  <div
                    className="w-3 h-3 rounded-sm flex-shrink-0 border-2"
                    style={{
                      backgroundColor: item.isVisible
                        ? item.color
                        : "transparent",
                      borderColor: item.color,
                    }}
                  />
                  <span className="text-gray-300">{item.label}</span>
                </div>
                <span className="text-gray-100 font-mono w-20 text-right">
                  {item.isVisible
                    ? displayValue === "power"
                      ? formatValue(item.powerValue)
                      : formatValue(item.energyValue, 1)
                    : ""}
                </span>
                <span className="text-gray-400 font-mono w-12 text-right">
                  {item.isVisible
                    ? formatPercentage(
                        displayValue === "power"
                          ? item.powerValue
                          : item.energyValue,
                        total,
                      )
                    : ""}
                </span>
              </div>
            );
          })}
        </div>

        {/* Total */}
        <div className="border-t border-gray-700 pt-1">
          <div className="flex items-center text-xs">
            <span className="text-gray-300 font-medium flex-1">Total</span>
            <span className="text-gray-100 font-mono font-medium w-20 text-right">
              {displayValue === "power"
                ? formatValue(total)
                : formatValue(total, 1)}
            </span>
            <span className="text-gray-400 font-mono font-medium w-12 text-right">
              {total !== null ? "100%" : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
