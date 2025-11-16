import React from "react";

export type PriceLevel = "low" | "medium" | "high" | "missing";

interface AmberPriceIndicatorProps {
  priceLevel: PriceLevel;
  size?: number;
  isPast?: boolean;
}

/**
 * Visual indicator for Amber Electric price levels
 * Matches Amber's design: green (low), yellow (medium), orange (high), gray dashed (missing)
 */
export function AmberPriceIndicator({
  priceLevel,
  size = 24,
  isPast = false,
}: AmberPriceIndicatorProps) {
  const viewBox = "0 0 238 238";
  const cx = 119;
  const cy = 119;
  const r = 119;

  if (priceLevel === "missing") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox={viewBox}
        aria-label="Data unavailable"
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="rgb(107, 114, 128)" // gray-500
          strokeWidth="20"
          strokeDasharray="40 20"
          fillRule="evenodd"
        />
      </svg>
    );
  }

  const colors: Record<Exclude<PriceLevel, "missing">, string> = {
    low: "rgb(74, 222, 128)", // green-400
    medium: "rgb(250, 204, 21)", // yellow-400
    high: "rgb(249, 115, 22)", // orange-500
  };

  const labels: Record<Exclude<PriceLevel, "missing">, string> = {
    low: "Low prices",
    medium: "Medium prices",
    high: "High prices",
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={viewBox}
      aria-label={labels[priceLevel]}
      opacity={isPast ? 0.4 : 1}
    >
      <title>{labels[priceLevel]}</title>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={colors[priceLevel]}
        fillRule="evenodd"
      />
    </svg>
  );
}

/**
 * Determine price level based on cents per kWh
 */
export function getPriceLevel(priceInCents: number | null): PriceLevel {
  if (priceInCents === null || priceInCents === undefined) {
    return "missing";
  }

  if (priceInCents < 15) {
    return "low";
  } else if (priceInCents < 25) {
    return "medium";
  } else {
    return "high";
  }
}
