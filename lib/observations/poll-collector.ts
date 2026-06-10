/**
 * Poll Collector
 *
 * Buffers a poll's raw observation inputs and emits a single combined QStash
 * message at session close — the completed session plus all of its readings,
 * chunked if the serialized message would exceed QStash's ~1MB size limit.
 *
 * This is the sole publish path for polls: one co-enqueued session+readings
 * message per chunk (replacing the old per-insert + separate-session flow).
 */

import {
  qstash,
  OBSERVATIONS_QUEUE_NAME,
  getObservationsReceiverUrl,
} from "@/lib/qstash";
import { Observation, QueueMessage, Session } from "./types";
import { SystemWithPolling } from "@/lib/systems-manager";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { buildObservations, RawObservationInput } from "./publisher";
import { WRITE_OUTBOX } from "@/lib/db/routing";
import { persistOutbox } from "./outbox";

/**
 * Default maximum serialized message size in bytes.
 *
 * QStash limits messages to ~1MB; we leave headroom and allow override via the
 * OBSERVATIONS_MAX_MESSAGE_BYTES environment variable.
 */
function getDefaultMaxBytes(): number {
  return Number(process.env.OBSERVATIONS_MAX_MESSAGE_BYTES ?? 900000);
}

/**
 * Accumulates raw observation inputs over the course of a poll, preserving
 * insertion order, so they can be flushed as a single combined message at
 * session close.
 */
export interface PollCollector {
  /** Append observation inputs (in insertion order). */
  add(inputs: RawObservationInput[]): void;
  /** All accumulated inputs, in insertion order. */
  readonly observations: RawObservationInput[];
}

/**
 * Create a new poll collector that buffers observation inputs in memory.
 */
export function createPollCollector(): PollCollector {
  const buffer: RawObservationInput[] = [];
  return {
    add(inputs: RawObservationInput[]): void {
      for (const input of inputs) {
        buffer.push(input);
      }
    },
    get observations(): RawObservationInput[] {
      return buffer;
    },
  };
}

/**
 * Compute the serialized byte length of a queue message.
 */
function messageByteLength(message: QueueMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

/**
 * Build the combined QStash message(s) for a completed poll.
 *
 * PURE (no I/O). Produces one or more QueueMessages, each carrying the same
 * `session` and a contiguous slice of the poll's observations. The union of
 * all chunks' observations equals the full ordered observation list with no
 * duplicates or gaps.
 *
 * - If there are no observations, returns exactly one message (session only).
 * - Observations are packed into as few chunks as possible such that each
 *   serialized message is <= maxBytes.
 * - A single observation whose own message exceeds maxBytes is STILL emitted
 *   alone — data is never dropped.
 */
export function buildPollMessages(args: {
  system: SystemWithPolling;
  session: Session;
  inputs: RawObservationInput[];
  maxBytes?: number;
}): QueueMessage[] {
  const { system, session, inputs } = args;
  const maxBytes = args.maxBytes ?? getDefaultMaxBytes();

  const env: QueueMessage["env"] =
    process.env.NODE_ENV === "production" ? "prod" : "dev";
  const batchTime = formatTime_fromJSDate(new Date(), system.timezoneOffsetMin);

  const baseMessage = (): QueueMessage => ({
    env,
    systemId: system.id,
    systemName: system.displayName,
    batchTime,
    session,
  });

  const observations = buildObservations(system, inputs);

  // No observations → a single session-only message.
  if (observations.length === 0) {
    return [baseMessage()];
  }

  const messages: QueueMessage[] = [];
  let chunk: Observation[] = [];

  const flush = (): void => {
    if (chunk.length > 0) {
      messages.push({ ...baseMessage(), observations: chunk });
      chunk = [];
    }
  };

  for (const observation of observations) {
    const candidate: Observation[] = [...chunk, observation];
    const candidateMessage: QueueMessage = {
      ...baseMessage(),
      observations: candidate,
    };

    if (messageByteLength(candidateMessage) <= maxBytes) {
      // Fits in the current chunk.
      chunk = candidate;
      continue;
    }

    // Doesn't fit. Flush the current chunk (if any) and start a new one.
    flush();

    // Place this observation in a fresh chunk. Even if a single observation
    // alone exceeds maxBytes, it is still emitted (never dropped).
    chunk = [observation];
  }

  flush();

  return messages;
}

/**
 * Publish a completed poll (session + all buffered observations) to the QStash
 * queue as one combined message per chunk.
 *
 * Side-effectful: builds messages via {@link buildPollMessages} and enqueues
 * each. If QStash is not configured (no client) or there is no receiver URL,
 * this silently no-ops. Errors are logged but never thrown — queue failures
 * must not break the main poll flow.
 */
export async function publishPoll(
  system: SystemWithPolling,
  session: Session,
  inputs: RawObservationInput[],
): Promise<void> {
  // Skip if no QStash client configured.
  if (!qstash) {
    return;
  }

  // Skip if no receiver URL (e.g., development without override).
  const receiverUrl = getObservationsReceiverUrl();
  if (!receiverUrl) {
    return;
  }

  try {
    const messages = buildPollMessages({ system, session, inputs });

    // Phase 4: durably capture the messages in PG first (a tee, in parallel with
    // the live direct enqueue below). Best-effort — never throws — so the direct
    // enqueue and the poll proceed unchanged when the flag is off or PG is down.
    if (WRITE_OUTBOX) {
      await persistOutbox(messages);
    }

    const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
    for (const message of messages) {
      await queue.enqueueJSON({
        url: receiverUrl,
        body: message,
      });
    }

    const totalObservations = messages.reduce(
      (sum, message) => sum + (message.observations?.length ?? 0),
      0,
    );
    console.log(
      `[PollCollector] Published poll for system ${system.id}: ` +
        `${messages.length} message(s), ${totalObservations} observations, ` +
        `session ${session.sessionId}`,
    );
  } catch (error) {
    // Log error but don't throw - the main poll flow must not be blocked by
    // queue failures.
    console.error(
      `[PollCollector] Failed to publish poll for system ${system.id}:`,
      error,
    );
  }
}
