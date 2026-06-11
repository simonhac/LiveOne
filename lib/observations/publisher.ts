/**
 * Observation Publisher
 *
 * Publishes observation batches to the QStash queue.
 * Designed for dual-write: publish to queue synchronously before DB insert.
 */

import {
  qstash,
  OBSERVATIONS_QUEUE_NAME,
  getObservationsReceiverUrl,
} from "@/lib/qstash";
import { Observation, QueueMessage } from "./types";
import { SystemWithPolling } from "@/lib/systems-manager";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import type { PointInfoRow } from "@/lib/point/point-manager";
import { PointReference } from "@/lib/identifiers";
import { persistOutbox } from "./outbox";

// Type for point info (the served point_info row shape).
type PointInfo = PointInfoRow;

/**
 * Input for a single observation (from insertPointReadingsRaw)
 */
export interface RawObservationInput {
  sessionId: string;
  point: PointInfo;
  value: number | string | null;
  measurementTimeMs: number;
  receivedTimeMs: number;
  interval: "raw" | "5m" | "1d";
  /** Full aggregate detail (supplied for interval "5m" / "1d"). */
  agg?: Observation["agg"];
}

/**
 * Build the MQTT-style topic for an observation
 * Format: liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}
 */
function buildTopic(system: SystemWithPolling, point: PointInfo): string {
  return `liveone/${system.vendorType}/${system.vendorSiteId}/${point.physicalPathTail}`;
}

/**
 * Format a millisecond timestamp as ISO 8601 with system's timezone offset
 * Includes milliseconds so sub-second precision survives the queue round-trip.
 * Example: "2025-01-15T20:30:00.123+10:00"
 */
function formatTimestamp(timeMs: number, timezoneOffsetMin: number): string {
  return formatTime_fromJSDate(new Date(timeMs), timezoneOffsetMin, true);
}

/**
 * Convert raw observation inputs to Observation objects
 */
export function buildObservations(
  system: SystemWithPolling,
  inputs: RawObservationInput[],
): Observation[] {
  return inputs.map((input) => ({
    sessionId: input.sessionId,
    topic: buildTopic(system, input.point),
    measurementTime: formatTimestamp(
      input.measurementTimeMs,
      system.timezoneOffsetMin,
    ),
    receivedTime: formatTimestamp(
      input.receivedTimeMs,
      system.timezoneOffsetMin,
    ),
    value: input.value,
    interval: input.interval,
    ...(input.agg ? { agg: input.agg } : {}),
    debug: {
      type: input.point.metricType,
      unit: input.point.metricUnit,
      pointName: input.point.displayName,
      reference: PointReference.fromIds(
        system.id,
        input.point.index,
      ).toString(),
    },
  }));
}

/**
 * Publish a batch of observations to the QStash queue.
 *
 * This is called synchronously during point reading insertion to ensure
 * observations are queued before database writes complete.
 *
 * Error handling: Failures are logged but do NOT break the database insertion.
 * If QStash is not configured (no token), this silently no-ops.
 *
 * @param system - The system the readings belong to
 * @param inputs - Array of raw observation inputs
 */
export async function publishObservationBatch(
  system: SystemWithPolling,
  inputs: RawObservationInput[],
): Promise<void> {
  // Skip if no QStash client configured
  if (!qstash) {
    return;
  }

  // Skip if no receiver URL (e.g., development without override)
  const receiverUrl = getObservationsReceiverUrl();
  if (!receiverUrl) {
    return;
  }

  // Skip if no observations
  if (inputs.length === 0) {
    return;
  }

  try {
    // Build the observation batch
    const observations = buildObservations(system, inputs);
    const message: QueueMessage = {
      env: process.env.NODE_ENV === "production" ? "prod" : "dev",
      systemId: system.id,
      systemName: system.displayName,
      batchTime: formatTimestamp(Date.now(), system.timezoneOffsetMin),
      observations,
    };

    // Durably capture in PG first (a tee, in parallel with the direct enqueue
    // below). Best-effort — never throws. The outbox is the durability anchor;
    // the relay re-drains anything the direct enqueue drops.
    await persistOutbox([message]);

    // Get the queue and publish
    const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
    await queue.enqueueJSON({
      url: receiverUrl,
      body: message,
    });

    console.log(
      `[ObservationPublisher] Published batch: ${observations.length} observations for system ${system.id}`,
    );
  } catch (error) {
    // Log error but don't throw - database writes should not be blocked by queue failures
    console.error(
      `[ObservationPublisher] Failed to publish batch for system ${system.id}:`,
      error,
    );
  }
}
