/**
 * Point Info - Frontend-safe point information with helper methods
 */

import { buildPointPath } from "./point-info-utils";

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
    public readonly shortName: string | null,
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
  ) {}

  /**
   * Get the display name (displayName if set, otherwise defaultName)
   */
  get name(): string {
    return this.displayName || this.defaultName;
  }

  /**
   * Get the point identifier in format type.subtype.extension (omitting null parts)
   * Returns null if type is null
   *
   * Examples:
   * - type="source", subtype="solar", extension=null → "source.solar"
   * - type="bidi", subtype="battery", extension="charge" → "bidi.battery.charge"
   * - type="load", subtype=null, extension=null → "load"
   */
  getIdentifier(): string | null {
    return buildPointPath(this.type, this.subtype, this.extension);
  }

  /**
   * Get the point index in format systemId.pointIndex
   *
   * Example: "1.5" for system 1, point index 5
   */
  getIndex(): string {
    return `${this.systemId}.${this.index}`;
  }

  /**
   * Get the flavour identifier for a specific aggregation
   * Format: metricType.aggregationField
   *
   * Example: "power.avg", "energy.delta", "soc.last"
   */
  getFlavourIdentifier(aggregationField: string): string {
    return `${this.metricType}.${aggregationField}`;
  }

  /**
   * Create a PointInfo from a plain object (e.g., from database row or API response)
   */
  static from(data: {
    id: number; // Database field name is still 'id'
    systemId: number;
    originId: string;
    originSubId: string | null;
    shortName: string | null;
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
  }): PointInfo {
    return new PointInfo(
      data.id, // Map database 'id' field to 'index' property
      data.systemId,
      data.originId,
      data.originSubId,
      data.shortName,
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
    );
  }
}
