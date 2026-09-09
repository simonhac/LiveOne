/**
 * Message chunking — the producer-side bound on how much work one QStash message can create.
 *
 * 🛑 THE BOUND BELONGS HERE, AT THE PRODUCER, NOT AT THE RECEIVER. A receiver-side rejection still
 * returns non-2xx, so QStash still retries it and still holds the delivery slot for the whole retry
 * schedule — a consumer-side cap reduces blast radius by exactly nothing. It is worse than nothing:
 * by the time the receiver sees a message its `observations_outbox` row is already marked
 * `published_at`, so a permanent rejection converts a latency problem into silent data loss, which
 * is the one thing the outbox exists to prevent.
 *
 * Two independent caps, because either alone is insufficient:
 *
 *  - BYTES (`OBSERVATIONS_MAX_MESSAGE_BYTES`, default 900 kB) — QStash's own ~1 MB message limit.
 *  - COUNT (`OBSERVATIONS_MAX_MESSAGE_OBSERVATIONS`, default 500) — the receiver's work per message.
 *
 * The count cap is the one the 2026-09-09 outage needed. That backfill emitted messages of ~1650
 * observations each; 1650 small rows fit comfortably inside 900 kB, so the byte cap let every one of
 * them through. What made them slow was the row count: one transaction and one unbounded 5m
 * recompute per message.
 *
 * See docs/plans/ingest-head-of-line-hardening.md.
 */

import { Observation, QueueMessage } from "./types";

/** QStash limits messages to ~1 MB; leave headroom. */
function maxMessageBytes(): number {
  return Number(process.env.OBSERVATIONS_MAX_MESSAGE_BYTES ?? 900000);
}

/** Observations per message. Bounds the receiver's transaction and its 5m recompute. */
export function maxMessageObservations(): number {
  return Number(process.env.OBSERVATIONS_MAX_MESSAGE_OBSERVATIONS ?? 500);
}

/** Serialized byte length of a queue message. */
function messageByteLength(message: QueueMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

/**
 * Split observations across as few messages as possible, subject to BOTH caps.
 *
 * PURE (no I/O). Each message carries a fresh copy of `base` (so the session, when present, rides
 * every chunk) and a contiguous slice of the observations. The union of all chunks equals the full
 * ordered list with no duplicates and no gaps.
 *
 * - Zero observations → exactly one message, carrying `base` alone.
 * - A single observation whose own message exceeds `maxBytes` is STILL emitted, alone. Data is
 *   never dropped by chunking; an oversized single observation is a data problem, not a transport
 *   one, and dropping it here would be a silent loss.
 */
export function buildChunkedMessages(args: {
  base: () => QueueMessage;
  observations: Observation[];
  maxBytes?: number;
  maxCount?: number;
}): QueueMessage[] {
  const { base, observations } = args;
  const maxBytes = args.maxBytes ?? maxMessageBytes();
  const maxCount = Math.max(1, args.maxCount ?? maxMessageObservations());

  if (observations.length === 0) {
    return [base()];
  }

  const messages: QueueMessage[] = [];
  let chunk: Observation[] = [];

  const flush = (): void => {
    if (chunk.length > 0) {
      messages.push({ ...base(), observations: chunk });
      chunk = [];
    }
  };

  for (const observation of observations) {
    // The count cap is checked first because it is the cheap one — no serialization needed.
    if (chunk.length >= maxCount) {
      flush();
      chunk = [observation];
      continue;
    }

    const candidate: Observation[] = [...chunk, observation];
    if (messageByteLength({ ...base(), observations: candidate }) <= maxBytes) {
      chunk = candidate;
      continue;
    }

    // Doesn't fit by bytes. Flush what we have and start a fresh chunk. Even if this observation
    // alone exceeds maxBytes it is still emitted (never dropped).
    flush();
    chunk = [observation];
  }

  flush();

  return messages;
}
