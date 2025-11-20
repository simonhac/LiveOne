import React from "react";

export type PriceLevel =
  | "extremelyLow"
  | "veryLow"
  | "low"
  | "neutral"
  | "high"
  | "missing";

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

  if (priceLevel === "extremelyLow") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox={viewBox}
        aria-label="Extremely low prices"
        opacity={isPast ? 0.4 : 1}
      >
        <title>Extremely low prices</title>
        <g fill="none" fillRule="evenodd">
          <path
            fill="rgb(74, 222, 128)" // green-400 (matches Amber's #00E3A0)
            d="M6.64823228,102.949747 L102.949747,6.64823228 C111.814057,-2.21607743 126.185943,-2.21607743 135.050253,6.64823228 L231.351768,102.949747 C240.216077,111.814057 240.216077,126.185943 231.351768,135.050253 L135.050253,231.351768 C126.185943,240.216077 111.814057,240.216077 102.949747,231.351768 L6.64823228,135.050253 C-2.21607743,126.185943 -2.21607743,111.814057 6.64823228,102.949747 Z"
          />
          <path
            fill="rgb(0, 11, 36)" // dark color for exclamation mark
            fillRule="nonzero"
            d="M129.635034,142.787707 L132.015625,52.0625 L105.984375,52.0625 L108.364966,142.787707 L129.635034,142.787707 Z M119.000627,185.9375 C125.85853,185.9375 131.91551,179.979606 132.015625,172.583599 C131.91551,165.290314 125.85853,159.383781 119.000627,159.383781 C111.792321,159.383781 105.885514,165.290314 105.985629,172.583599 C105.885514,179.979606 111.792321,185.9375 119.000627,185.9375 Z"
          />
        </g>
      </svg>
    );
  }

  const colors: Record<Exclude<PriceLevel, "missing">, string> = {
    extremelyLow: "rgb(74, 222, 128)", // green-400 (matches Amber's NEGATIVE_SPIKE)
    veryLow: "rgb(74, 222, 128)", // green-400 (matches Amber's GOOD)
    low: "rgb(250, 204, 21)", // yellow-400 (matches Amber's NEUTRAL)
    neutral: "rgb(250, 204, 21)", // yellow-400
    high: "rgb(249, 115, 22)", // orange-500
  };

  const labels: Record<Exclude<PriceLevel, "missing">, string> = {
    extremelyLow: "Extremely low prices",
    veryLow: "Very low prices",
    low: "Low prices",
    neutral: "Neutral prices",
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
 * Thresholds match Amber Electric's actual API values:
 * - extremelyLow: < 17¢ (GraphQL NEGATIVE_SPIKE: 11-17¢, REST extremelyLow: 4-17¢)
 * - veryLow: 17-26¢ (GraphQL GOOD: 19-27¢, REST veryLow: 17-26¢)
 * - low: 26-34¢ (GraphQL NEUTRAL: 28-29¢, REST low: 26-33¢)
 * - neutral: 34-38¢ (REST neutral: 38-40¢)
 * - high: ≥ 38¢ (orange/spike prices)
 */
export function getPriceLevel(priceInCents: number | null): PriceLevel {
  if (priceInCents === null || priceInCents === undefined) {
    return "missing";
  }

  if (priceInCents < 17) {
    return "extremelyLow";
  } else if (priceInCents < 26) {
    return "veryLow";
  } else if (priceInCents < 34) {
    return "low";
  } else if (priceInCents < 38) {
    return "neutral";
  } else {
    return "high";
  }
}
