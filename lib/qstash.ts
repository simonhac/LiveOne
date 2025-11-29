import { Client } from "@upstash/qstash";

/**
 * QStash client for publishing observations to the queue.
 * Gracefully degrades if not configured (returns null).
 */
export const qstash = process.env.OBSERVATIONS_QSTASH_TOKEN
  ? new Client({ token: process.env.OBSERVATIONS_QSTASH_TOKEN })
  : null;

/**
 * Queue name for observation batches
 */
export const OBSERVATIONS_QUEUE_NAME = "observations";

/**
 * Get the receiver URL for the observations queue.
 * This is the endpoint that QStash will deliver messages to.
 * Returns null in development (QStash can't reach localhost).
 */
export function getObservationsReceiverUrl(): string | null {
  // Allow explicit override via env var
  if (process.env.OBSERVATIONS_QSTASH_RECEIVER_URL) {
    return process.env.OBSERVATIONS_QSTASH_RECEIVER_URL;
  }

  // In production, use the Vercel URL
  const baseUrl = process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL;
  if (!baseUrl) {
    // Development - QStash can't reach localhost
    return null;
  }

  return `https://${baseUrl}/api/observations/receive`;
}
