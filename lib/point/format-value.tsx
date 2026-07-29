import { formatRelativeTime } from "@/lib/fe-date-format";
import { getUnitDisplay } from "@/lib/point/unit-display";
import { applyExcelFormat } from "@/lib/point/display/excel-format";
import { classifyUnit } from "@/lib/point/unit-typography";

export interface ValueParts {
  /** The formatted number, with NO unit. A React element for complex blobs (e.g. a location). */
  value: string | React.ReactElement;
  /** The display unit, if any — hand this to `<Value unit>`. */
  unit?: string;
}

/**
 * Format a value into its number and unit as SEPARATE fields.
 *
 * Prefer this over {@link formatValueWithUnit} anywhere the result is rendered as a hero value: a
 * concatenated "1234 rpm" string forces the unit to hero size, which is what
 * docs/architecture/number-typography.md exists to prevent. Pass the parts to `<Value>` instead.
 *
 * Shared by the raw-readings table (LatestReadingsClient) and the generic device-metrics card so the
 * two never diverge on how a point's value renders. When the central display registry
 * (lib/point/display) covers a point, the caller passes `displayUnit`/`displayFormat` and we render
 * the raw value via the point's Excel-style format instead of the metricUnit switch.
 */
export function formatValueParts(
  value: number | string | boolean,
  metricUnit: string,
  displayUnitOverride?: string,
  displayFormat?: string,
): ValueParts {
  // Handle json metricUnit (e.g., location) - value is a JSON string
  if (metricUnit === "json" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed.lat !== undefined && parsed.lon !== undefined) {
        return {
          value: (
            <span className="text-xs text-gray-400">
              {parsed.lat.toFixed(5)}, {parsed.lon.toFixed(5)}
            </span>
          ),
        };
      }
      return { value };
    } catch {
      return { value };
    }
  }

  // Handle boolean values
  if (typeof value === "boolean") {
    return { value: value ? "true" : "false" };
  }

  // Handle string values (like tariff codes)
  if (typeof value === "string") {
    return { value };
  }

  // Central display registry wins when it covers this point: format the raw value per its
  // Excel-style number format and use the registry's display unit.
  if (displayFormat) {
    const unit = displayUnitOverride || getUnitDisplay(metricUnit);
    return {
      value: applyExcelFormat(value, displayFormat),
      unit: unit || undefined,
    };
  }

  // Format numeric values based on unit
  const displayUnit = getUnitDisplay(metricUnit);

  switch (metricUnit) {
    case "W":
    case "Wh":
      // Display raw values without scaling
      return { value: value.toLocaleString(), unit: displayUnit };
    case "%":
      return { value: value.toFixed(1), unit: "%" };
    case "cents_kWh":
      return { value: value.toFixed(2), unit: displayUnit };
    case "cents":
      return { value: value.toFixed(2), unit: "¢" };
    case "epochMs":
      // Format as readable time
      return { value: formatRelativeTime(new Date(value)) };
    case "text":
      return { value: String(value) };
    default:
      return {
        value: Number.isInteger(value)
          ? value.toLocaleString()
          : value.toFixed(2),
        unit: displayUnit || undefined,
      };
  }
}

/**
 * Format a value with its unit as a single string — for plain-text contexts (table cells, tooltips,
 * `title` attributes). The joiner follows the same tight/spaced rule as `<Value>`, so "40.0°C" and
 * "1234 rpm" agree with their rendered counterparts.
 *
 * For hero values use {@link formatValueParts} + `<Value>` instead.
 */
export function formatValueWithUnit(
  value: number | string | boolean,
  metricUnit: string,
  displayUnitOverride?: string,
  displayFormat?: string,
): string | React.ReactElement {
  const parts = formatValueParts(
    value,
    metricUnit,
    displayUnitOverride,
    displayFormat,
  );
  if (typeof parts.value !== "string" || !parts.unit) return parts.value;
  const joiner = classifyUnit(parts.unit).headGap === "hair" ? " " : "";
  return `${parts.value}${joiner}${parts.unit}`;
}
