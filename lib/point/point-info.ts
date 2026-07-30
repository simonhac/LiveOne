/**
 * Point Info - Frontend-safe point information with helper methods
 */

import { PointReference } from "@/lib/identifiers";

/**
 * The plain-object shape `PointInfo.from()` accepts — a DB row, a served row, or a JSON API
 * response, which is exactly what `NextResponse.json(pointInfoInstance)` emits (the class's own
 * properties; the `name` getter lives on the prototype and is not serialized).
 *
 * Exported so a client can TYPE an API response against it rather than casting. That matters:
 * `pointUid` is required, and an `as any` at the fetch boundary is precisely the hole that would
 * let a route stop projecting it without anything failing to compile.
 */
export interface PointInfoWire {
  /** `point_info.point_uid` (NOT NULL). See the constructor doc. */
  pointUid: string;
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
  displayUnit?: string | null;
  displayFormat?: string | null;
}

/**
 * Point information with helper methods
 * This class is safe to use on both frontend and backend
 */
export class PointInfo {
  constructor(
    /**
     * The point's stable public identity — the `point_info.point_uid` column (NOT NULL).
     *
     * FIRST, ahead of the legacy `(index, systemId)` address, because that is what this
     * identity replaces: `Point.encode(pointUid)` is the `PointId` every readings path keys
     * on, so a holder of a `PointInfo` never needs `RegistryCache.pointForAddr` to rediscover
     * it (config-v4 Phase 12 slice D). `index`/`systemId` are the renameable ADDRESS and die
     * with the handle in Phase 13.
     */
    public readonly pointUid: string,
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
    // Resolved from the central display registry (lib/point/display) server-side; null when no
    // manifest covers this point. `displayFormat` is an Excel-style number format (e.g. "0.0").
    public readonly displayUnit: string | null = null,
    public readonly displayFormat: string | null = null,
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
   * Example: PointReference(1, 5) for device 1, point index 5
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
  static from(data: PointInfoWire): PointInfo {
    // `pointUid` is NOT NULL in `point_info`, so an absent one never means "this point has no
    // identity" — it means a producer dropped it (a route that didn't project the column, or a
    // wire shape that predates it). That is the config-v4 "wired at MINT, not at EDIT" failure
    // class in its cross-boundary form: a silently-undefined field typed `string` reads as
    // working right up until something calls `Point.encode()` on it. Fail here instead.
    if (!data.pointUid) {
      throw new Error(
        "PointInfo.from: pointUid is required (point_info.point_uid is NOT NULL) — " +
          "the producer dropped the point's identity",
      );
    }
    return new PointInfo(
      data.pointUid,
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
      data.displayUnit ?? null,
      data.displayFormat ?? null,
    );
  }
}
