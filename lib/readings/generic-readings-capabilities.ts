/**
 * Standard capabilities for systems using the generic readings table
 * Format: type.subtype.extension (subtype and extension optional)
 */
export const GENERIC_READINGS_CAPABILITIES: string[] = [
  "source.solar",
  "source.solar.local",
  "source.solar.remote",
  "load",
  "bidi.battery",
  "bidi.grid",
];
