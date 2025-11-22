/**
 * Unit Display Mappings
 *
 * Maps metric units from the database to display-friendly units.
 * Used across the application for consistent unit display.
 */

/**
 * Get the display unit for a metric unit
 *
 * @param metricUnit - The metric unit from point_info (e.g., "cents_kWh", "epochMs")
 * @returns The display unit (e.g., "¢/kWh", "time")
 */
export function getUnitDisplay(metricUnit: string | null): string {
  if (!metricUnit) return "";

  // Special unit mappings
  const unitMap: Record<string, string> = {
    cents_kWh: "¢/kWh",
    cents: "¢",
    epochMs: "time",
    text: "(text)",
  };

  return unitMap[metricUnit] || metricUnit;
}

/**
 * Get the context-aware display unit for a point
 *
 * This function considers both the metric type and unit, as well as
 * optional context like view mode (raw/5m/daily) and transforms.
 *
 * @param metricType - The metric type (e.g., "energy", "power", "time")
 * @param metricUnit - The metric unit (e.g., "Wh", "W", "epochMs")
 * @param options - Optional context for unit selection
 * @returns The display unit appropriate for the context
 */
export function getContextualUnitDisplay(
  metricType: string,
  metricUnit: string | null,
  options?: {
    /** Data source view mode */
    source?: "raw" | "5m" | "daily";
    /** Point transform (e.g., "d" for differentiated) */
    transform?: string | null;
  },
): string {
  const { source, transform } = options || {};

  // Energy units depend on view mode and transform
  if (metricType === "energy") {
    // Differentiated points in raw view show MWh
    if (transform === "d" && source === "raw") {
      return "MWh";
    }
    // Daily view shows kWh for all energy points
    if (source === "daily") {
      return "kWh";
    }
    // Default energy unit
    return "Wh";
  }

  // Power is always shown in kW
  if (metricType === "power") {
    return "kW";
  }

  // Time with epochMs unit
  if (metricType === "time" && metricUnit === "epochMs") {
    return "time";
  }

  // Fall back to simple unit mapping
  return getUnitDisplay(metricUnit);
}
