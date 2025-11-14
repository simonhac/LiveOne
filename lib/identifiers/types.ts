/**
 * Core identifier types for the LiveOne system
 *
 * These types replace string-based parsing throughout the codebase,
 * providing type safety and validation at serialization boundaries.
 */

/**
 * System Identifier
 *
 * Formats:
 * - Numeric ID: "123"
 * - User-scoped shortname: "username.shortname" (e.g., "simon.kinkora")
 *
 * Note: User-scoped format is not yet fully implemented
 */
export class SystemIdentifier {
  private constructor(
    public readonly type: "id" | "shortname",
    public readonly id?: number,
    public readonly username?: string,
    public readonly shortname?: string,
  ) {}

  /**
   * Parse a system identifier string
   * Returns null if format is invalid
   *
   * @example
   * SystemIdentifier.parse("123") // SystemIdentifier { type: "id", id: 123 }
   * SystemIdentifier.parse("simon.kinkora") // SystemIdentifier { type: "shortname", username: "simon", shortname: "kinkora" }
   * SystemIdentifier.parse("invalid") // null
   */
  static parse(str: string): SystemIdentifier | null {
    // Try parsing as numeric ID first
    if (/^\d+$/.test(str)) {
      const id = parseInt(str, 10);
      if (id > 0) {
        return new SystemIdentifier("id", id);
      }
      return null;
    }

    // Try parsing as username.shortname format
    const dotIndex = str.indexOf(".");
    if (dotIndex > 0 && dotIndex < str.length - 1) {
      const username = str.substring(0, dotIndex);
      const shortname = str.substring(dotIndex + 1);

      // Basic validation: alphanumeric, underscore, hyphen
      const validPattern = /^[a-zA-Z0-9_-]+$/;
      if (validPattern.test(username) && validPattern.test(shortname)) {
        return new SystemIdentifier(
          "shortname",
          undefined,
          username,
          shortname,
        );
      }
    }

    return null;
  }

  /**
   * Create a system identifier from a string, throwing on invalid format
   * Use this for internal code where you expect the format to be valid
   */
  static from(str: string): SystemIdentifier {
    const result = SystemIdentifier.parse(str);
    if (!result) {
      throw new Error(`Invalid SystemIdentifier format: ${str}`);
    }
    return result;
  }

  /**
   * Create a system identifier from a numeric ID
   */
  static fromId(id: number): SystemIdentifier {
    if (id <= 0 || !Number.isInteger(id)) {
      throw new Error(`Invalid system ID: ${id}`);
    }
    return new SystemIdentifier("id", id);
  }

  /**
   * Create a system identifier from username and shortname
   */
  static fromShortname(username: string, shortname: string): SystemIdentifier {
    if (!username || !shortname) {
      throw new Error("Username and shortname are required");
    }
    return new SystemIdentifier("shortname", undefined, username, shortname);
  }

  /**
   * Serialize to string format
   */
  toString(): string {
    if (this.type === "id") {
      return this.id!.toString();
    } else {
      return `${this.username}.${this.shortname}`;
    }
  }

  /**
   * Check equality with another SystemIdentifier
   */
  equals(other: SystemIdentifier): boolean {
    if (this.type !== other.type) return false;
    if (this.type === "id") {
      return this.id === other.id;
    } else {
      return (
        this.username === other.username && this.shortname === other.shortname
      );
    }
  }
}

/**
 * Point Reference - Composite key for database lookups
 *
 * Format: "{systemId}.{pointId}"
 * Example: "1.5" (system 1, point 5)
 */
export class PointReference {
  private constructor(
    public readonly systemId: number,
    public readonly pointId: number,
  ) {}

  /**
   * Parse a point reference string
   * Returns null if format is invalid
   *
   * @example
   * PointReference.parse("1.5") // PointReference { systemId: 1, pointId: 5 }
   * PointReference.parse("invalid") // null
   */
  static parse(str: string): PointReference | null {
    const parts = str.split(".");
    if (parts.length !== 2) {
      return null;
    }

    const systemId = parseInt(parts[0], 10);
    const pointId = parseInt(parts[1], 10);

    if (
      isNaN(systemId) ||
      isNaN(pointId) ||
      systemId <= 0 ||
      pointId <= 0 ||
      systemId.toString() !== parts[0] ||
      pointId.toString() !== parts[1]
    ) {
      return null;
    }

    return new PointReference(systemId, pointId);
  }

  /**
   * Create a point reference from a string, throwing on invalid format
   */
  static from(str: string): PointReference {
    const result = PointReference.parse(str);
    if (!result) {
      throw new Error(`Invalid PointReference format: ${str}`);
    }
    return result;
  }

  /**
   * Create a point reference from numeric IDs
   */
  static fromIds(systemId: number, pointId: number): PointReference {
    if (
      systemId <= 0 ||
      pointId <= 0 ||
      !Number.isInteger(systemId) ||
      !Number.isInteger(pointId)
    ) {
      throw new Error(
        `Invalid point reference IDs: systemId=${systemId}, pointId=${pointId}`,
      );
    }
    return new PointReference(systemId, pointId);
  }

  /**
   * Serialize to string format
   */
  toString(): string {
    return `${this.systemId}.${this.pointId}`;
  }

  /**
   * Check equality with another PointReference
   */
  equals(other: PointReference): boolean {
    return this.systemId === other.systemId && this.pointId === other.pointId;
  }

  /**
   * Create a hash key for use in Maps/Sets
   */
  toHashKey(): string {
    return this.toString();
  }
}

/**
 * Point Path - Unique identifier for a point within its system
 *
 * Format with type: "{type}.{subtype}.{extension}/{metricType}"
 * Format without type: "{pointIndex}/{metricType}"
 *
 * Examples:
 * - "load.hvac/power"
 * - "source.solar/energy"
 * - "bidi.battery.charge/power"
 * - "load/power" (no subtype/extension)
 * - "5/power" (fallback for points without type - just the pointIndex)
 */
export class PointPath {
  private constructor(
    public readonly type: string,
    public readonly subtype: string | null,
    public readonly extension: string | null,
    public readonly metricType: string,
    public readonly isFallback: boolean = false,
  ) {}

  /**
   * Get the point index if this is a fallback path, null otherwise
   */
  get pointIndex(): number | null {
    if (this.isFallback) {
      const idx = parseInt(this.type, 10);
      return isNaN(idx) ? null : idx;
    }
    return null;
  }

  /**
   * Parse a point path string
   * Returns null if format is invalid
   *
   * @example
   * PointPath.parse("load.hvac/power") // PointPath { type: "load", subtype: "hvac", ... }
   * PointPath.parse("5/power") // PointPath { isFallback: true, type: "5", metricType: "power" }
   * PointPath.parse("invalid") // null
   */
  static parse(str: string): PointPath | null {
    // Must contain exactly one slash
    const slashIndex = str.indexOf("/");
    if (slashIndex === -1 || str.indexOf("/", slashIndex + 1) !== -1) {
      return null;
    }

    const pointIdentifier = str.substring(0, slashIndex);
    const metricType = str.substring(slashIndex + 1);

    // Validate metric type is non-empty
    if (!metricType) {
      return null;
    }

    // Check if this is a numeric-only point index (fallback format)
    if (/^\d+$/.test(pointIdentifier)) {
      const pointIndex = parseInt(pointIdentifier, 10);
      if (pointIndex > 0) {
        // Fallback format: just pointIndex/metricType
        return new PointPath(pointIdentifier, null, null, metricType, true);
      }
      return null;
    }

    // Parse point identifier (type.subtype.extension)
    const parts = pointIdentifier.split(".");

    if (parts.length === 0 || parts.length > 3) {
      return null;
    }

    // Validate no empty parts
    if (parts.some((p) => !p)) {
      return null;
    }

    const type = parts[0];
    const subtype = parts.length > 1 ? parts[1] : null;
    const extension = parts.length > 2 ? parts[2] : null;

    return new PointPath(type, subtype, extension, metricType, false);
  }

  /**
   * Create a point path from a string, throwing on invalid format
   */
  static from(str: string): PointPath {
    const result = PointPath.parse(str);
    if (!result) {
      throw new Error(`Invalid PointPath format: ${str}`);
    }
    return result;
  }

  /**
   * Create a point path from components
   */
  static fromComponents(
    type: string,
    subtype: string | null,
    extension: string | null,
    metricType: string,
  ): PointPath {
    if (!type || !metricType) {
      throw new Error("type and metricType are required");
    }

    // Validate no empty strings (null is ok)
    if (subtype === "" || extension === "") {
      throw new Error("subtype and extension must be non-empty or null");
    }

    return new PointPath(type, subtype, extension, metricType, false);
  }

  /**
   * Create a fallback point path for points without type
   * Format: "{pointId}/{metricType}"
   * Example: "5/power"
   */
  static createFallback(pointId: number, metricType: string): PointPath {
    if (pointId <= 0 || !Number.isInteger(pointId)) {
      throw new Error(`Invalid pointId: ${pointId}`);
    }
    if (!metricType) {
      throw new Error("metricType is required");
    }
    return new PointPath(pointId.toString(), null, null, metricType, true);
  }

  /**
   * Serialize to string format
   */
  toString(): string {
    if (this.isFallback) {
      // Fallback format: just pointIndex/metricType
      return `${this.type}/${this.metricType}`;
    }

    let path = this.type;
    if (this.subtype) {
      path += `.${this.subtype}`;
      if (this.extension) {
        path += `.${this.extension}`;
      }
    }
    return `${path}/${this.metricType}`;
  }

  /**
   * Get just the point identifier part (without metric type)
   * Useful for display purposes
   */
  getPointIdentifier(): string {
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
   * Check equality with another PointPath
   */
  equals(other: PointPath): boolean {
    return (
      this.type === other.type &&
      this.subtype === other.subtype &&
      this.extension === other.extension &&
      this.metricType === other.metricType
    );
  }

  /**
   * Create a hash key for use in Maps/Sets
   */
  toHashKey(): string {
    return this.toString();
  }

  /**
   * Check if this point path matches the given point identifier and metric type
   * @param pointIdentifier - Point identifier in format "type.subtype.extension" or "type.subtype" or "type"
   * @param metricType - Metric type to match (e.g., "power", "soc", "energy")
   * @returns true if the point path matches
   *
   * @example
   * path.matches("bidi.battery", "soc") // true if path is "bidi.battery/soc"
   * path.matches("load.hvac", "power") // true if path is "load.hvac/power" or "load.hvac.xyz/power"
   * path.matches("source.solar", "energy") // true if path is "source.solar/energy" or "source.solar.remote/energy"
   */
  matches(pointIdentifier: string, metricType: string): boolean {
    // Check metric type
    if (this.metricType !== metricType) {
      return false;
    }

    // Parse the point identifier
    const parts = pointIdentifier.split(".");

    if (parts.length === 0 || parts.length > 3) {
      return false;
    }

    const type = parts[0];
    const subtype = parts.length > 1 ? parts[1] : null;
    const extension = parts.length > 2 ? parts[2] : null;

    // Check type
    if (this.type !== type) {
      return false;
    }

    // Check subtype if specified
    if (subtype !== null && this.subtype !== subtype) {
      return false;
    }

    // Check extension if specified
    if (extension !== null && this.extension !== extension) {
      return false;
    }

    return true;
  }
}

/**
 * Series Path - Full identifier for a queryable data series
 *
 * Format: "{systemIdentifier}/{pointPath}.{aggregationField}"
 * Examples:
 * - "1/load.hvac/power.avg" (numeric system ID)
 * - "simon.kinkora/source.solar/power.avg" (user-scoped shortname)
 *
 * This combines:
 * - Which system (numeric ID or user.shortname)
 * - Which point (including metric type)
 * - Which aggregation to use
 */
export class SeriesPath {
  private constructor(
    public readonly systemIdentifier: SystemIdentifier,
    public readonly pointPath: PointPath,
    public readonly aggregationField: string,
  ) {}

  /**
   * Parse a series path string
   * Returns null if format is invalid
   *
   * @example
   * SeriesPath.parse("1/load.hvac/power.avg")
   * // SeriesPath {
   * //   systemIdentifier: SystemIdentifier { type: "id", id: 1 },
   * //   pointPath: PointPath { type: "load", subtype: "hvac", metricType: "power" },
   * //   aggregationField: "avg"
   * // }
   */
  static parse(str: string): SeriesPath | null {
    // Find first slash (separates system from point path)
    const firstSlash = str.indexOf("/");
    if (firstSlash === -1) {
      return null;
    }

    const systemIdStr = str.substring(0, firstSlash);
    const remainder = str.substring(firstSlash + 1);

    // Parse system identifier
    const systemIdentifier = SystemIdentifier.parse(systemIdStr);
    if (!systemIdentifier) {
      return null;
    }

    // Find last dot (separates aggregation field from point path)
    const lastDot = remainder.lastIndexOf(".");
    if (lastDot === -1) {
      return null;
    }

    const pointPathStr = remainder.substring(0, lastDot);
    const aggregationField = remainder.substring(lastDot + 1);

    if (!aggregationField) {
      return null;
    }

    // Parse point path
    const pointPath = PointPath.parse(pointPathStr);
    if (!pointPath) {
      return null;
    }

    return new SeriesPath(systemIdentifier, pointPath, aggregationField);
  }

  /**
   * Create a series path from a string, throwing on invalid format
   */
  static from(str: string): SeriesPath {
    const result = SeriesPath.parse(str);
    if (!result) {
      throw new Error(`Invalid SeriesPath format: ${str}`);
    }
    return result;
  }

  /**
   * Create a series path from components
   */
  static fromComponents(
    systemIdentifier: SystemIdentifier,
    pointPath: PointPath,
    aggregationField: string,
  ): SeriesPath {
    if (!aggregationField) {
      throw new Error("aggregationField is required");
    }

    return new SeriesPath(systemIdentifier, pointPath, aggregationField);
  }

  /**
   * Serialize to string format
   */
  toString(): string {
    return `${this.systemIdentifier.toString()}/${this.pointPath.toString()}.${this.aggregationField}`;
  }

  /**
   * Check equality with another SeriesPath
   */
  equals(other: SeriesPath): boolean {
    return (
      this.systemIdentifier.equals(other.systemIdentifier) &&
      this.pointPath.equals(other.pointPath) &&
      this.aggregationField === other.aggregationField
    );
  }

  /**
   * Create a hash key for use in Maps/Sets
   */
  toHashKey(): string {
    return this.toString();
  }
}
