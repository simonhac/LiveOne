/**
 * Point Info - Frontend-safe point information with helper methods
 */

import { PointReference } from "@/lib/identifiers";

/**
 * Point information with helper methods
 * This class is safe to use on both frontend and backend
 */
export class PointInfo {
  constructor(
    public readonly index: number,
    public readonly systemId: number,
    public readonly physicalPathTail: string, // "/" separated suffix, e.g., "solar_w", "B1/kwh"
    public readonly logicalPathStem: string | null, // "." separated, e.g., "source.solar"
    public readonly metricType: string, // e.g., "power", "energy", "soc"
    public readonly metricUnit: string, // e.g., "W", "Wh", "%"
    public readonly defaultName: string, // from vendor
    public readonly displayName: string | null, // user-customizable
    public readonly subsystem: string | null, // for UI color coding
    public readonly transform: string | null, // null | 'i' | 'd'
    public readonly active: boolean,
    public readonly createdAtMs: number,
    public readonly updatedAtMs: number | null,
  ) {}

  /**
   * Get the display name (displayName if set, otherwise defaultName)
   */
  get name(): string {
    return this.displayName || this.defaultName;
  }

  /**
   * Get the full logical path (logicalPathStem + "/" + metricType)
   * Returns null if logicalPathStem is null
   *
   * @example
   * // logicalPathStem: "source.solar", metricType: "power"
   * point.getLogicalPath() // "source.solar/power"
   */
  getLogicalPath(): string | null {
    if (!this.logicalPathStem) return null;
    return `${this.logicalPathStem}/${this.metricType}`;
  }

  /**
   * Get the point path as a string
   * Uses logical path if available, falls back to index-based path
   */
  getPath(): string {
    const logicalPath = this.getLogicalPath();
    if (logicalPath) {
      return logicalPath;
    }
    // Fallback for points without logicalPathStem
    return `${this.index}/${this.metricType}`;
  }

  /**
   * Get the PointReference for this point (composite database key)
   * Format: "systemId.pointIndex"
   *
   * Example: PointReference(1, 5) for system 1, point index 5
   */
  getReference(): PointReference {
    return PointReference.fromIds(this.systemId, this.index);
  }

  /**
   * Get the preferred aggregation type for this metric type
   *
   * @returns The preferred aggregation field for this metric type
   *
   * Rules:
   * - energy: "delta" (cumulative change)
   * - soc: "last" (latest value)
   * - power and others: "avg" (average)
   */
  getPreferredAggregation(): string {
    return PointInfo.getPreferredAggregationForMetricType(this.metricType);
  }

  /**
   * Static helper: Get the preferred aggregation type for a given metric type
   *
   * @param metricType - The metric type (e.g., "energy", "soc", "power")
   * @returns The preferred aggregation field for this metric type
   *
   * Rules:
   * - energy: "delta" (cumulative change)
   * - soc: "last" (latest value)
   * - power and others: "avg" (average)
   */
  static getPreferredAggregationForMetricType(metricType: string): string {
    switch (metricType) {
      case "energy":
        return "delta";
      case "soc":
        return "last";
      default:
        return "avg";
    }
  }

  /**
   * Get the point identifier (the logicalPathStem)
   * Returns null if logicalPathStem is null
   */
  getIdentifier(): string | null {
    return this.logicalPathStem;
  }

  /**
   * @deprecated Use getReference().toString() instead
   * Get the point index in format systemId.pointIndex
   */
  getIndex(): string {
    return `${this.systemId}.${this.index}`;
  }

  /**
   * Create a PointInfo from a plain object (e.g., from database row or API response)
   */
  static from(data: {
    index: number; // Database field name is 'id', exposed as 'index' in TypeScript
    systemId: number;
    physicalPathTail: string;
    logicalPathStem: string | null;
    metricType: string;
    metricUnit: string;
    defaultName: string;
    displayName: string | null;
    subsystem: string | null;
    transform: string | null;
    active: boolean;
    createdAtMs: number;
    updatedAtMs: number | null;
  }): PointInfo {
    return new PointInfo(
      data.index,
      data.systemId,
      data.physicalPathTail,
      data.logicalPathStem,
      data.metricType,
      data.metricUnit,
      data.defaultName,
      data.displayName,
      data.subsystem,
      data.transform,
      data.active,
      data.createdAtMs,
      data.updatedAtMs,
    );
  }
}
