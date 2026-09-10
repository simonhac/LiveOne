import { Client } from "@upstash/qstash";
import { isProduction } from "./env";
import { OBSERVATION_LANES, type ObservationLane } from "./observations/types";

/**
 * QStash client for publishing observations to the queue.
 * Gracefully degrades if not configured (returns null).
 */
export const qstash = process.env.OBSERVATIONS_QSTASH_TOKEN
  ? new Client({ token: process.env.OBSERVATIONS_QSTASH_TOKEN })
  : null;

/**
 * The FIFO QStash Queue observations used to ride, retired at the 2026-09-10 cutover.
 *
 * Nothing publishes here any more — this exists ONLY so `queue timing` can still classify the log
 * rows QStash retains from before the flip, which would otherwise render as `foreign` and make a
 * window that was perfectly healthy look unattributable. It is a log-reading concern, not a
 * transport: there is no client, no queue name in flight, and no way back to it.
 *
 * 🛑 Delete this, and its use in `lib/observations/message-log.ts`, once QStash's log retention no
 * longer reaches 2026-09-10. At that point it can only ever match zero rows.
 */
export const RETIRED_QUEUE_NAME = isProduction()
  ? "observations"
  : "observations-dev";

/**
 * Flow-control key prefix, split by environment.
 *
 * 🛑 The two prefixes must be DISJOINT UNDER PREFIX MATCHING, not merely different. Dev and prod
 * share one QStash account and one `OBSERVATIONS_QSTASH_TOKEN`, so any prod-side "is this ours?"
 * filter is a prefix test — and `"obs.dev.live".startsWith("obs.")` is `true`, which would sweep
 * dev keys into a prod view. `"obs-dev.live".startsWith("obs.")` is `false`. That is why the
 * environment goes in the PREFIX and not in a middle segment.
 *
 * 🛑 **`isProduction()`, NOT `NODE_ENV`** — and this is the whole reason it matters. A Vercel
 * PREVIEW build runs with `NODE_ENV=production` (it is a production build of Next.js) while
 * `VERCEL_ENV=preview`, so keying off `NODE_ENV` gave every preview deployment prod's `obs:`
 * prefix and prod's queue name. `OBSERVATIONS_QSTASH_TOKEN` is set in the Preview scope, so those
 * are live handles, not inert strings: after the flow-control cutover a preview-targeted
 * `liveone queue pause` would have paused PROD's ingest lane. `lib/env.ts` is the one discriminator
 * that knows preview is not production.
 */
export const OBSERVATIONS_FLOW_PREFIX = isProduction() ? "obs" : "obs-dev";

/**
 * The character set QStash accepts in a flow-control key.
 *
 * 🛑 **No colon.** `publishJSON` rejects anything else with
 * `{"error":"flowControlKey must be alphanumeric, hyphen, underscore, or period"}` — a 400 on
 * EVERY publish, i.e. total ingest failure. This is asserted by test rather than trusted, because
 * `flowControl.get()` does NOT enforce it: on 2026-09-10 the prod cutover published nothing for
 * 2m45s while `liveone queue status` cheerfully reported both lanes as present and healthy, because
 * a GET on the impossible key `obs:live` returned 200. An illegal key is invisible from the read
 * side and fatal on the write side.
 */
export const FLOW_KEY_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * The separator between the environment prefix and the lane.
 *
 * 🛑 It must satisfy TWO constraints at once, and the obvious choice fails the second:
 *
 *   1. **Legal** — in `FLOW_KEY_CHARSET`. That rules out the `:` this used until 2026-09-10.
 *   2. **Prefix-disjoint** — no dev key may start with `<prod prefix><separator>`. `-` LOOKS like
 *      the natural substitute and breaks this: prod `obs-live` vs dev `obs-dev-live`, and
 *      `"obs-dev-live".startsWith("obs-")` is `true`. Swapping `:` for `-` would have fixed the
 *      400 and silently reintroduced the collision the prefix split exists to prevent.
 *
 * `.` satisfies both: `"obs-dev.live".startsWith("obs.")` is `false`.
 */
const FLOW_KEY_SEPARATOR = ".";

/**
 * The flow-control key for a lane, e.g. `obs.live` / `obs-dev.backfill`.
 *
 * Fixed cardinality — two keys per environment, forever. Keying per DEVICE (the shape originally
 * proposed) does not scale: key cardinality would grow with the fleet, `GET /v2/flowControl` is
 * unpaginated, there is no atomic global pause, and total in-flight would be
 * `devices × parallelism`, which passes the Postgres pool long before "thousands of devices".
 */
export function observationsFlowKey(lane: ObservationLane): string {
  return `${OBSERVATIONS_FLOW_PREFIX}${FLOW_KEY_SEPARATOR}${lane}`;
}

/** Parse one of our flow-control keys back to its lane. `null` when it is not ours. */
export function parseObservationsFlowKey(key: string): ObservationLane | null {
  for (const lane of OBSERVATION_LANES) {
    if (key === observationsFlowKey(lane)) return lane;
  }
  return null;
}

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
  //
  // 🛑 `isProduction()` for the same reason as the prefix above, and the stakes here are the
  // highest of the three: a Vercel preview has `NODE_ENV=production` but no
  // `OBSERVATIONS_QSTASH_RECEIVER_URL` of its own, so it fell through to THIS line and would have
  // delivered preview-originated readings into the PRODUCTION serving store. Preview now falls
  // through to the dev receiver below, which logs and writes nothing.
  if (isProduction()) {
    return PRODUCTION_RECEIVER_URL;
  }

  // Development: use production URL with dev receiver endpoint
  // This allows testing the queue pipeline from localhost
  return "https://liveone.vercel.app/api/observations/receive-dev";
}
