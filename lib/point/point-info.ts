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
    public readonly originId: string,
    public readonly originSubId: string | null,
    public readonly alias: string | null,
    public readonly defaultName: string,
    public readonly displayName: string | null,
    public readonly subsystem: string | null,
    public readonly type: string | null,
    public readonly subtype: string | null,
    public readonly extension: string | null,
    public readonly metricType: string,
    public readonly metricUnit: string,
    public readonly transform: string | null,
    public readonly active: boolean,
    public readonly logicalPath: string | null,
    public readonly physicalPath: string,
  ) {}

  /**
   * Get the display name (displayName if set, otherwise defaultName)
   */
  get name(): string {
    return this.displayName || this.defaultName;
  }

  /**
   * @deprecated Use logicalPath property instead. This method will be removed.
   * Get the point path as a string (falls back to index-based path if type is null)
   */
  getPath(): string {
    if (this.logicalPath) {
      return this.logicalPath;
    }
    // Fallback for points without type
    return `${this.index}/${this.metricType}`;
  }

  /**
   * @deprecated Use logicalPath property instead. This method will be removed.
   * Get the logical path for typed points only
   */
  getLogicalPath(): string | null {
    return this.logicalPath;
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
   * @deprecated Use getPath().toString() instead
   * Get the point identifier in format type.subtype.extension (omitting null parts)
   * Returns null if type is null
   */
  getIdentifier(): string | null {
    if (!this.type) return null;
    let path = this.type;
    if (this.subtype) {
      path += `.${this.subtype}`;
      if (this.extension) {
        path += `.${this.extension}`;
      }
    }
    return path;
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
    originId: string;
    originSubId: string | null;
    alias: string | null;
    defaultName: string;
    displayName: string | null;
    subsystem: string | null;
    type: string | null;
    subtype: string | null;
    extension: string | null;
    metricType: string;
    metricUnit: string;
    transform: string | null;
    active: boolean;
    logicalPath: string | null;
    physicalPath: string;
  }): PointInfo {
    return new PointInfo(
      data.index, // Database 'id' column exposed as 'index' property
      data.systemId,
      data.originId,
      data.originSubId,
      data.alias,
      data.defaultName,
      data.displayName,
      data.subsystem,
      data.type,
      data.subtype,
      data.extension,
      data.metricType,
      data.metricUnit,
      data.transform,
      data.active,
      data.logicalPath,
      data.physicalPath,
    );
  }
}
