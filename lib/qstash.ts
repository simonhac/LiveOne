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
 * Stable public production domain for the receiver. Must be a public, custom
 * domain — NOT a `*.vercel.app` per-deployment URL, which Vercel Deployment
 * Protection gates behind a 401 auth wall that QStash cannot pass.
 */
const PRODUCTION_RECEIVER_URL =
  "https://www.liveone.energy/api/observations/receive";

/**
 * Get the receiver URL for the observations queue.
 * This is the endpoint that QStash will deliver messages to.
 *
 * The URL must be publicly reachable: QStash POSTs to it from Upstash's
 * infrastructure, so it can never be a deployment-protected `VERCEL_URL`
 * (the per-deployment hostname returns 401 to QStash). We resolve to a stable
 * public domain instead.
 *
 * In production: uses the public custom domain with the main receiver.
 * In development: uses the production URL with the dev receiver endpoint
 *                 (since QStash can't reach localhost).
 */
export function getObservationsReceiverUrl(): string | null {
  // Allow explicit override via env var
  if (process.env.OBSERVATIONS_QSTASH_RECEIVER_URL) {
    return process.env.OBSERVATIONS_QSTASH_RECEIVER_URL;
  }

  // Existing repo convention for the public app URL (see enphase-auth.ts).
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return `${process.env.NEXT_PUBLIC_APP_URL}/api/observations/receive`;
  }

  // Production: stable public custom domain (NOT VERCEL_URL — see above).
  if (process.env.NODE_ENV === "production") {
    return PRODUCTION_RECEIVER_URL;
  }

  // Development: use production URL with dev receiver endpoint
  // This allows testing the queue pipeline from localhost
  return "https://liveone.vercel.app/api/observations/receive-dev";
}
