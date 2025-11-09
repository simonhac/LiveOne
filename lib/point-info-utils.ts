/**
 * Utility functions for working with point_info metadata
 */

/**
 * Build a point path from type, subtype, and extension
 * Format: type.subtype.extension (omitting null parts)
 *
 * Examples:
 * - type="source", subtype="solar", extension=null → "source.solar"
 * - type="bidi", subtype="battery", extension="charge" → "bidi.battery.charge"
 * - type="load", subtype=null, extension=null → "load"
 *
 * @param type - Point type (e.g., "source", "bidi", "load")
 * @param subtype - Point subtype (e.g., "solar", "battery", "grid") or null
 * @param extension - Point extension (e.g., "remote", "charge", "import") or null
 * @returns Path string in format type.subtype.extension (omitting null parts), or null if type is null
 */
export function buildPointPath(
  type: string | null,
  subtype: string | null,
  extension: string | null,
): string | null {
  if (!type) return null;

  const parts = [type, subtype, extension].filter(
    (part): part is string => part !== null,
  );
  return parts.join(".");
}
