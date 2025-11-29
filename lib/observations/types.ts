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

  /** Metadata that can be stripped for terse payloads */
  metadata: {
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
 * Batch of observations from a single poll
 * This is the payload sent to QStash (one message per poll)
 */
export interface ObservationBatch {
  /** System ID for quick filtering */
  systemId: number;

  /** System display name for convenience */
  systemName: string;

  /** ISO 8601 timestamp when this batch was created */
  batchTime: string;

  /** Array of observations from this poll */
  observations: Observation[];
}
