import { Client } from "@upstash/qstash";

/**
 * QStash client for publishing observations to the queue.
 * Gracefully degrades if not configured (returns null).
 */
export const qstash = process.env.OBSERVATIONS_QSTASH_TOKEN
  ? new Client({ token: process.env.OBSERVATIONS_QSTASH_TOKEN })
  : null;

/**
 * Queue name for observation batches.
 * Uses environment-specific names to separate dev and prod messages.
 */
export const OBSERVATIONS_QUEUE_NAME =
  process.env.NODE_ENV === "production" ? "observations" : "observations-dev";

/**
 * Get the receiver URL for the observations queue.
 * This is the endpoint that QStash will deliver messages to.
 *
 * In production: uses the main receiver endpoint
 * In development: uses the dev receiver endpoint at the production URL
 *                 (since QStash can't reach localhost)
 */
export function getObservationsReceiverUrl(): string | null {
  // Allow explicit override via env var
  if (process.env.OBSERVATIONS_QSTASH_RECEIVER_URL) {
    return process.env.OBSERVATIONS_QSTASH_RECEIVER_URL;
  }

  // In production, use the Vercel URL with the main receiver
  const baseUrl = process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL;
  if (baseUrl) {
    return `https://${baseUrl}/api/observations/receive`;
  }

  // Development: use production URL with dev receiver endpoint
  // This allows testing the queue pipeline from localhost
  return "https://liveone.vercel.app/api/observations/receive-dev";
}
