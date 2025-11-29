/**
 * Observation Types for the QStash Queue
 *
 * MQTT-inspired message format for streaming point readings
 * through a queue for decoupled ingestion.
 */

/**
 * Individual observation (one point reading)
 */
export interface Observation {
  /** Session ID that captured this observation */
  sessionId: number;

  /** MQTT-style topic: "liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}" */
  topic: string;

  /** ISO 8601 with system timezone offset: "2025-01-15T20:30:00+10:00" */
  measurementTime: string;

  /** ISO 8601 with system timezone offset */
  receivedTime: string;

  /** The reading value (numeric, string for text metrics, or null for errors) */
  value: number | string | null;

  /** Which insertion path generated this: "raw" for point_readings, "5m" for pre-aggregated */
  interval: "raw" | "5m";

  /** Optional debug info (can be stripped for terse payloads) */
  debug?: {
    /** metricType (power, energy, soc, etc.) */
    type: string;
    /** metricUnit (W, kWh, %, text, etc.) */
    unit: string;
    /** Point display name */
    pointName: string;
    /** Standard point reference: "{systemId}.{pointIndex}" */
    reference: string;
  };
}

/**
 * Session data for the queue
 * Represents a communication session with an energy system
 */
export interface Session {
  /** Session ID from the database */
  sessionId: number;

  /** Label for grouping sessions (e.g., deployment ID suffix) */
  sessionLabel: string | null;

  /** What triggered the session: CRON, ADMIN, USER, PUSH, etc. */
  cause: string;

  /** ISO 8601 with system timezone offset */
  started: string;

  /** Duration in milliseconds */
  durationMs: number;

  /** Success state: true=success, false=failed, null=pending */
  successful: boolean | null;

  /** Short error code/number */
  errorCode: string | null;

  /** Detailed error message */
  error: string | null;

  /** Full server response (JSON) */
  response: unknown;

  /** Count of data rows received */
  numRows: number;

  /** ISO 8601 with system timezone offset - when session record was created */
  startTime: string;
}

/**
 * Unified queue message for QStash
 * Can contain observations and/or session data
 */
export interface QueueMessage {
  /** Environment: "prod" or "dev" */
  env: "prod" | "dev";

  /** System ID for quick filtering */
  systemId: number;

  /** System display name for convenience */
  systemName: string;

  /** ISO 8601 timestamp when this message was created (with system timezone) */
  batchTime: string;

  /** Array of observations from this poll (optional) */
  observations?: Observation[];

  /** Session data (optional) */
  session?: Session;
}

/**
 * @deprecated Use QueueMessage instead
 */
export type ObservationBatch = QueueMessage;
