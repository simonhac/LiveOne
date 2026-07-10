/**
 * gusher — the generic push (receiver) contract, shared by the receiver (`app/api/gush/route.ts`)
 * and the collector's pushers (musher/fusher).
 *
 * A "pusher" POSTs **self-describing** point readings to `/api/gush`: each reading carries its own
 * point metadata, so the server needs no per-vendor knowledge. This is the HTTP serialization of the
 * existing point-readings interface (`PointReadingInput` + `PointMetadata`).
 */

/** One self-describing point reading (a serialized `PointReadingInput` + its `PointMetadata`). */
export interface PushReading {
  /** vendor-native key, unique per system — the dedup key + `point_info` identity */
  physicalPathTail: string;
  /** number → `point_readings.value`; string → `value_str` (use metricUnit "text"/"json"); null = skip */
  value: number | string | null;
  /** e.g. "power" | "energy" | "soc" | "voltage" | "temperature" | "speed" | ... (free-form) */
  metricType: string;
  /** e.g. "W" | "Wh" | "%" | "V" | "°C" | "rpm" | "Hz" | "text" (free-form) */
  metricUnit: string;
  /** dotted semantic path, e.g. "generator.battery" (optional) */
  logicalPathStem?: string | null;
  /** display name; defaults to physicalPathTail */
  defaultName?: string;
  /** e.g. "generator" | "solar" | "battery" | "grid" (optional) */
  subsystem?: string | null;
  /** "d" for a cumulative-counter energy point; otherwise null/omitted */
  transform?: string | null;
  /** ISO8601; overrides the batch `measurementTime` for this reading */
  measurementTime?: string;
}

/** The `POST /api/gush` request body. */
export interface GushRequestBody {
  /** identifies the system (matches `systems.vendor_site_id`) */
  vendorSiteId: string;
  /** validated against the system owner's stored credential (`credentials.apiKey`) */
  apiKey: string;
  /** "test" = auth check only; "store" = persist the readings */
  action: "test" | "store";
  /** unique id for this batch — session label + idempotency (required for "store") */
  sessionLabel?: string;
  /** ISO8601 default measurement time for the batch (required for "store" unless every reading sets its own) */
  measurementTime?: string;
  /** the self-describing readings (required for "store") */
  readings?: PushReading[];
}
