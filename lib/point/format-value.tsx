import { formatRelativeTime } from "@/lib/fe-date-format";
import { getUnitDisplay } from "@/lib/point/unit-display";
import { applyExcelFormat } from "@/lib/point/display/excel-format";

/**
 * Format a value with its unit for display.
 * Returns either a string or a React element for complex displays (like a JSON location blob).
 *
 * Shared by the raw-readings table (LatestReadingsClient) and the generic device-metrics card so the
 * two never diverge on how a point's value renders. When the central display registry
 * (lib/point/display) covers a point, the caller passes `displayUnit`/`displayFormat` and we render
 * the raw value via the point's Excel-style format instead of the metricUnit switch.
 */
export function formatValueWithUnit(
  value: number | string | boolean,
  metricUnit: string,
  displayUnitOverride?: string,
  displayFormat?: string,
): string | React.ReactElement {
  // Handle json metricUnit (e.g., location) - value is a JSON string
  if (metricUnit === "json" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed.lat !== undefined && parsed.lon !== undefined) {
        return (
          <span className="text-xs text-gray-400">
            {parsed.lat.toFixed(5)}, {parsed.lon.toFixed(5)}
          </span>
        );
      }
      return value;
    } catch {
      return value;
    }
  }

  // Handle boolean values
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  // Handle string values (like tariff codes)
  if (typeof value === "string") {
    return value;
  }

  // Central display registry wins when it covers this point: format the raw value per its
  // Excel-style number format and use the registry's display unit.
  if (displayFormat) {
    const unit = displayUnitOverride || getUnitDisplay(metricUnit);
    const formatted = applyExcelFormat(value, displayFormat);
    return unit ? `${formatted} ${unit}` : formatted;
  }

  // Format numeric values based on unit
  const displayUnit = getUnitDisplay(metricUnit);

  switch (metricUnit) {
    case "W":
    case "Wh":
      // Display raw values without scaling
      return `${value.toLocaleString()} ${displayUnit}`;
    case "%":
      return `${value.toFixed(1)}%`;
    case "cents_kWh":
      return `${value.toFixed(2)} ${displayUnit}`;
    case "cents":
      return `${value.toFixed(2)}¢`;
    case "epochMs":
      // Format as readable time
      return formatRelativeTime(new Date(value));
    case "text":
      return String(value);
    default:
      // Default: show value with unit
      if (Number.isInteger(value)) {
        return `${value.toLocaleString()} ${displayUnit}`;
      }
      return `${value.toFixed(2)} ${displayUnit}`;
  }
}
