/**
 * Session Publisher
 *
 * Publishes session data to the QStash queue for replication.
 * Called after session results are updated in the database.
 */

import {
  qstash,
  OBSERVATIONS_QUEUE_NAME,
  getObservationsReceiverUrl,
} from "@/lib/qstash";
import { QueueMessage, Session } from "./types";
import { SystemsManager } from "@/lib/systems-manager";
import { formatTime_fromJSDate } from "@/lib/date-utils";

/**
 * Input data for publishing a session
 */
export interface SessionPublishInput {
  id: number;
  sessionLabel: string | null;
  systemId: number;
  cause: string;
  started: Date;
  duration: number;
  successful: boolean | null;
  errorCode: string | null;
  error: string | null;
  response: unknown;
  numRows: number;
  createdAt: Date;
}

/**
 * Format a Date as ISO 8601 with system's timezone offset
 */
function formatTimestamp(date: Date, timezoneOffsetMin: number): string {
  return formatTime_fromJSDate(date, timezoneOffsetMin);
}

/**
 * Publish a session to the QStash queue.
 *
 * This is called after updateSessionResult() to replicate session data.
 * Error handling: Failures are logged but do NOT break the main flow.
 * If QStash is not configured (no token), this silently no-ops.
 *
 * @param input - Session data to publish
 */
export async function publishSession(
  input: SessionPublishInput,
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

  try {
    // Look up system for timezone offset
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(input.systemId);
    if (!system) {
      console.error(
        `[SessionPublisher] System ${input.systemId} not found, skipping publish`,
      );
      return;
    }

    const timezoneOffsetMin = system.timezoneOffsetMin;

    // Build the session object
    const session: Session = {
      sessionId: input.id,
      sessionLabel: input.sessionLabel,
      cause: input.cause,
      started: formatTimestamp(input.started, timezoneOffsetMin),
      durationMs: input.duration,
      successful: input.successful,
      errorCode: input.errorCode,
      error: input.error,
      response: input.response,
      numRows: input.numRows,
      startTime: formatTimestamp(input.createdAt, timezoneOffsetMin),
    };

    // Build the queue message
    const message: QueueMessage = {
      env: process.env.NODE_ENV === "production" ? "prod" : "dev",
      systemId: system.id,
      systemName: system.displayName,
      batchTime: formatTimestamp(new Date(), timezoneOffsetMin),
      session,
    };

    // Get the queue and publish
    const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
    await queue.enqueueJSON({
      url: receiverUrl,
      body: message,
    });

    console.log(
      `[SessionPublisher] Published session ${input.id} for system ${system.id}`,
    );
  } catch (error) {
    // Log error but don't throw - main flow should not be blocked by queue failures
    console.error(
      `[SessionPublisher] Failed to publish session ${input.id}:`,
      error,
    );
  }
}
