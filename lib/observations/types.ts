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
  /** Session ID that captured this observation (UUIDv7 text; historical = stringified int) */
  sessionId: string;

  /**
   * The point's stable public identity (`point_uid` uuid) — since config-v4 slice M the SOLE identity
   * on the wire; the receiver resolves it via the DAO seam (`Point.encode` → `ReadingsDao`).
   *
   * Still optional in the TYPE only, because the receiver parses untrusted JSON: an in-flight message
   * from a pre-slice-M publisher would otherwise be a lie the compiler endorses. The receiver treats a
   * missing value as a loud, counted skip (`*NoPointUid`), never a throw — a throw would be a poison
   * pill, and gate G3 (0 unpublished outbox rows lacking `pointUid`, an empty DLQ) is what establishes
   * at merge time that no such message exists.
   */
  pointUid?: string;

  /** MQTT-style topic: "liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}" */
  topic: string;

  /** ISO 8601 with device timezone offset: "2025-01-15T20:30:00+10:00" */
  measurementTime: string;

  /** ISO 8601 with device timezone offset */
  receivedTime: string;

  /** The reading value (numeric, string for text metrics, or null for errors) */
  value: number | string | null;

  /**
   * Which insertion path generated this:
   * "raw" → point_readings, "5m" → point_readings_agg_5m, "1d" → point_readings_agg_1d.
   */
  interval: "raw" | "5m" | "1d";

  /**
   * Full aggregate detail for aggregated (`interval: "5m"` / `"1d"`) observations.
   * Carries the complete tuple so the Postgres mirror is full-fidelity rather than
   * collapsing everything into the single `value` field. (For 1d, `valueStr`/
   * `dataQuality` are unused — the daily table has no such columns.)
   * Absent for raw observations (and for legacy 5m messages published before this
   * field existed — the consumer falls back to `value` in that case).
   */
  agg?: {
    avg: number | null;
    min: number | null;
    max: number | null;
    last: number | null;
    delta: number | null;
    valueStr: string | null;
    sampleCount: number;
    errorCount: number;
    dataQuality: string | null;
  };

  /** Optional debug info (can be stripped for terse payloads) */
  debug?: {
    /** metricType (power, energy, soc, etc.) */
    type: string;
    /** metricUnit (W, kWh, %, text, etc.) */
    unit: string;
    /** Point display name */
    pointName: string;
    // `reference` ("{systemId}.{pointIndex}") was removed by config-v4 slice M along with the
    // receiver's legacy grammar. `pointUid` is the identity; this block is display-only debug.
  };
}

/**
 * Session data for the queue
 * Represents a communication session with an energy device
 */
export interface Session {
  /** Session ID from the database (UUIDv7 text; historical = stringified int) */
  sessionId: string;

  /** Label for grouping sessions (e.g., deployment ID suffix) */
  sessionLabel: string | null;

  /** What triggered the session: CRON, ADMIN, USER, PUSH, etc. */
  cause: string;

  /** ISO 8601 with device timezone offset */
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

  /** ISO 8601 with device timezone offset - when session record was created */
  startTime: string;
}

/**
 * Unified queue message for QStash
 * Can contain observations and/or session data
 */
export interface QueueMessage {
  /** Environment: "prod" or "dev" */
  env: "prod" | "dev";

  /** Device ID for quick filtering */
  systemId: number;

  /** Device display name for convenience */
  systemName: string;

  /** ISO 8601 timestamp when this message was created (with device timezone) */
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
