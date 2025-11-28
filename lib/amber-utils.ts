import {
  getPriceLevel,
  type PriceLevel,
} from "@/components/AmberPriceIndicator";

// Re-export PriceLevel and utilities for use by Amber components
export { type PriceLevel, getPriceLevel };

/**
 * Extended point value that can handle both numeric and string values
 * (e.g., price in cents or descriptor like "extremelyLow")
 */
export interface LatestValue {
  value: number | string;
  measurementTime?: Date;
  metricUnit?: string;
  displayName?: string;
}

/**
 * Get a numeric value from latest values store
 */
export function getNumericValue(
  latest: Record<string, LatestValue | null> | null,
  path: string,
): number | null {
  const point = latest?.[path];
  if (!point) return null;
  if (typeof point.value === "number") return point.value;
  // Try to parse string as number
  if (typeof point.value === "string") {
    const parsed = parseFloat(point.value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Get a string value from latest values store
 */
export function getStringValue(
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
 * Map Amber API descriptor to our PriceLevel type
 */
export function descriptorToPriceLevel(descriptor: string | null): PriceLevel {
  if (!descriptor) return "missing";

  switch (descriptor) {
    case "extremelyLow":
      return "extremelyLow";
    case "veryLow":
      return "veryLow";
    case "low":
      return "low";
    case "neutral":
      return "neutral";
    case "high":
    case "spike":
      return "high";
    default:
      return "neutral";
  }
}

/**
 * Human-readable label for price level (all caps like Amber iPhone app)
 */
export function getPriceLevelLabel(priceLevel: PriceLevel): string {
  switch (priceLevel) {
    case "extremelyLow":
      return "EXTREMELY LOW PRICES";
    case "veryLow":
      return "VERY LOW PRICES";
    case "low":
      return "LOW PRICES";
    case "neutral":
      return "NEUTRAL PRICES";
    case "high":
      return "HIGH PRICES";
    case "missing":
      return "PRICE UNAVAILABLE";
  }
}

/**
 * Get gradient background for price level circle (matches Amber's exact gradients)
 */
export function getPriceLevelGradient(priceLevel: PriceLevel): string {
  switch (priceLevel) {
    case "extremelyLow":
    case "veryLow":
      // Amber's green gradient
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(0, 255, 168) 0%, rgb(0, 202, 147) 100%)";
    case "low":
    case "neutral":
      // Amber's yellow/amber gradient
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(255, 230, 120) 0%, rgb(255, 198, 36) 100%)";
    case "high":
      // Amber's orange gradient
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(255, 180, 100) 0%, rgb(255, 130, 50) 100%)";
    case "missing":
      return "radial-gradient(110.63% 110.63% at 50% 29.42%, rgb(120, 120, 120) 0%, rgb(80, 80, 80) 100%)";
  }
}

/**
 * Generate summary message based on price level and renewables
 */
export function getSummaryMessage(
  priceLevel: PriceLevel,
  renewables: number | null,
  spikeStatus: string | null,
): string {
  const isGreen = renewables !== null && renewables > 50;
  const isSpike = spikeStatus === "spike" || spikeStatus === "potential";

  switch (priceLevel) {
    case "extremelyLow":
      if (isGreen) {
        return "Wow! It's really cheap and really green to use energy right now!";
      }
      return "Great time to use energy — prices are extremely low!";

    case "veryLow":
      if (isGreen) {
        return "Good time to use energy — cheap and green!";
      }
      return "Prices are very low — good time to use energy.";

    case "low":
      return "Prices are low — reasonable time to use energy.";

    case "neutral":
      return "Prices are normal for this time of day.";

    case "high":
      if (isSpike) {
        return "Warning: Prices are spiking. Consider reducing usage.";
      }
      return "Prices are elevated. Consider delaying non-essential usage.";

    case "missing":
      return "Price data is currently unavailable.";
  }
}
