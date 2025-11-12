import { PointInfo } from "./point-info";

/**
 * Point flavour - represents a specific aggregation of a metric type
 * Format: metricType.aggregationField
 * Examples: "power.avg", "energy.delta", "soc.last"
 */
export class PointFlavour {
  metricType: string; // e.g., "power", "energy", "soc"
  aggregationField: string; // e.g., "avg", "last", "delta", "min", "max"

  constructor(metricType: string, aggregationField: string) {
    this.metricType = metricType;
    this.aggregationField = aggregationField;
  }

  /**
   * Get the flavour identifier string (metricType.aggregationField)
   */
  getIdentifier(): string {
    return `${this.metricType}.${this.aggregationField}`;
  }

  /**
   * Determine which intervals support this flavour
   */
  getSupportedIntervals(): ("5m" | "1d")[] {
    if (this.metricType === "energy") {
      // Energy delta available in both 5m and 1d
      return this.aggregationField === "delta" ? ["5m", "1d"] : [];
    } else if (this.metricType === "soc") {
      // SOC: last in both, avg/min/max only in 1d
      if (this.aggregationField === "last") {
        return ["5m", "1d"];
      } else if (["avg", "min", "max"].includes(this.aggregationField)) {
        return ["1d"];
      }
      return [];
    } else {
      // Power and other: avg in both, min/max only in 1d, last in both
      if (this.aggregationField === "avg" || this.aggregationField === "last") {
        return ["5m", "1d"];
      } else if (["min", "max"].includes(this.aggregationField)) {
        return ["1d"];
      }
      return [];
    }
  }
}

/**
 * A point combined with its flavour (metric type + aggregation)
 * This represents a specific series that can be queried and displayed
 */
export interface FlavouredPoint {
  point: PointInfo;
  flavour: PointFlavour;
  intervals: ("5m" | "1d")[]; // Which intervals support this series
}

/**
 * Create a PointFlavour from string components
 */
export function createPointFlavour(
  metricType: string,
  aggregationField: string,
): PointFlavour {
  return new PointFlavour(metricType, aggregationField);
}

/**
 * Create a FlavouredPoint from a PointInfo and flavour components
 */
export function createFlavouredPoint(
  point: PointInfo,
  metricType: string,
  aggregationField: string,
): FlavouredPoint {
  const flavour = new PointFlavour(metricType, aggregationField);
  return {
    point,
    flavour,
    intervals: flavour.getSupportedIntervals(),
  };
}

/**
 * Get the flavour identifier string (metricType.aggregationField)
 * @deprecated Use flavour.getIdentifier() instead
 */
export function getFlavourIdentifier(flavour: PointFlavour): string {
  return flavour.getIdentifier();
}

/**
 * Get the full series path for a flavoured point
 * Format: pointIdentifier/flavourIdentifier
 * Example: "bidi.battery/power.avg"
 */
export function getSeriesPath(flavouredPoint: FlavouredPoint): string | null {
  const pointIdentifier = flavouredPoint.point.getIdentifier();
  if (!pointIdentifier) return null;

  const flavourId = flavouredPoint.flavour.getIdentifier();
  return `${pointIdentifier}/${flavourId}`;
}
