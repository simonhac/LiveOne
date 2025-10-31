import type { Capability } from "@/lib/vendors/types";

/**
 * Standard capabilities for systems using the generic readings table
 */
export const GENERIC_READINGS_CAPABILITIES: Capability[] = [
  { type: "source", subtype: "solar", extension: "total" },
  { type: "source", subtype: "solar", extension: "local" },
  { type: "source", subtype: "solar", extension: "remote" },
  { type: "load", subtype: null, extension: null },
  { type: "bidi", subtype: "battery", extension: null },
  { type: "bidi", subtype: "grid", extension: null },
];
