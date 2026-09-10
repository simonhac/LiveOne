/**
 * The observations publish contract — ONE delivery option set, used by EVERY publish site.
 *
 * Before this module the option set was empty in four separate places (`lib/observations/outbox.ts`,
 * `poll-collector.ts`, `publisher.ts`, `app/api/admin/observations/dlq/route.ts`), so every message
 * inherited QStash's defaults. That is what turned the 2026-09-09 Amber backfill into a 2h20m
 * fleet-wide ingest outage: with `timeout` unset, QStash's per-attempt ceiling is the *plan* maximum
 * (2 hours on pay-as-you-go), and the default retry backoff (~12s / 148s / 1808s ≈ 32.8 min) is what
 * actually held the FIFO lane for the observed 34 minutes per message.
 *
 * The point of this module is that it must never again be possible to add a publish site that
 * silently inherits those defaults. Import `observationDeliveryOptions()` and spread it.
 *
 * It also owns the delivery TRANSPORT: `publishObservationMessage()` is the single place that
 * publishes, and since the 2026-09-10 cutover it publishes to a flow-control lane. The legacy FIFO
 * Queue and the `OBSERVATIONS_PUBLISH_MODE` switch that selected it are gone.
 *
 * 🛑 The rollback is no longer an env-var flip, and does not need to be: `observations_outbox` is
 * teed BEFORE publish, so a publish that throws leaves the row `published_at = NULL` and the relay
 * cron retries it every minute. A broken publish path costs latency, not data — which is what the
 * 2026-09-10 attempt demonstrated, recovering a 2m45s backlog unaided.
 *
 * See docs/plans/ingest-head-of-line-hardening.md.
 */

import {
  qstash,
  observationsFlowKey,
  OBSERVATIONS_FLOW_PREFIX,
  getObservationsReceiverUrl,
} from "@/lib/qstash";
import type { ObservationLane, QueueMessage } from "./types";

/**
 * Delivery attempts after the first. Left at QStash's default: the DLQ signal and
 * `monitor-observations`' `dlq_present` alert are calibrated to it.
 */
function observationRetries(): number {
  return Number(process.env.OBSERVATIONS_RETRIES ?? 3);
}

/**
 * Retry backoff, as a QStash delay expression in milliseconds (`retried` counts from 0):
 * 5s / 15s / 45s ≈ 65s total, deliberately SHORT.
 *
 * QStash's retry budget is not our durability mechanism — `observations_outbox` retains payloads for
 * 30 days (`OUTBOX_GC_DAYS`) and the receiver is idempotent, so a message that fails four times in a
 * minute belongs in the DLQ where the monitor cron sees it, not occupying a delivery slot for half
 * an hour. First retry is 5s rather than 1s so a Postgres failover or a cold start is not converted
 * into DLQ traffic.
 */
function observationRetryDelay(): string {
  return (
    process.env.OBSERVATIONS_RETRY_DELAY ??
    "min(120000, 5000 * pow(3, retried))"
  );
}

/**
 * Per-attempt HTTP timeout in SECONDS.
 *
 * 🛑 Deliberately just ABOVE the receiver's `maxDuration` (60s, set in vercel.json), never below. If
 * QStash gave up first it would retry while the original invocation is still inside its transaction,
 * putting two concurrent upserts on the same `(point_rid, measurement_time)` rows — idempotent, but
 * lock-contending. The function's own bound is the authoritative one; this only stops QStash from
 * holding a slot for the plan maximum when the receiver never answers at all.
 */
function observationTimeoutSeconds(): number {
  return Number(process.env.OBSERVATIONS_RECEIVE_TIMEOUT_S ?? 65);
}

/**
 * The delivery options every observations publish must carry.
 *
 * Together these bound a poison message's worst-case occupancy of a delivery slot at roughly
 * `4 × 65s + 65s of backoff ≈ 5 minutes`, down from `4 × 2h + 33min`.
 */
export function observationDeliveryOptions(): {
  retries: number;
  retryDelay: string;
  timeout: number;
} {
  return {
    retries: observationRetries(),
    retryDelay: observationRetryDelay(),
    timeout: observationTimeoutSeconds(),
  };
}

/**
 * Per-lane concurrency.
 *
 * 🛑 The invariant is on the SUM, not on either number: every in-flight delivery is a concurrent
 * receiver invocation and therefore a Postgres connection, so `live + backfill` must stay within
 * `PLANETSCALE_POOL_MAX` (10). `getPoolConfig` notes `max` is per-instance and the real budget is
 * `max × warm instances`, so these are deliberately conservative.
 *
 * Live is given the larger share because it is the traffic that must never wait; backfill is
 * throttled on purpose — being slow is the entire point of putting it in its own lane.
 */
export function laneParallelism(lane: ObservationLane): number {
  const override =
    lane === "live"
      ? process.env.OBSERVATIONS_PARALLELISM_LIVE
      : process.env.OBSERVATIONS_PARALLELISM_BACKFILL;
  if (override !== undefined) return Number(override);
  return lane === "live" ? 5 : 2;
}

/** The lane a message rides. Absent means live — correct for every pre-lane outbox row. */
export function messageLane(message: QueueMessage): ObservationLane {
  return message.lane ?? "live";
}

/**
 * Publish ONE observations message, onto its lane.
 *
 * The single publish path. Every message carries the same delivery option set, so a lane changes
 * only what a message waits behind — never how long a bad one can hold it.
 *
 * Throws on failure: callers decide whether that is fatal (the relay marks the row unpublished and
 * retries next minute) or best-effort (the producers log and let the poll continue).
 */
export async function publishObservationMessage(
  message: QueueMessage,
): Promise<void> {
  if (!qstash) return;
  const receiverUrl = getObservationsReceiverUrl();
  if (!receiverUrl) return;

  const lane = messageLane(message);
  await qstash.publishJSON({
    url: receiverUrl,
    body: message,
    ...observationDeliveryOptions(),
    flowControl: {
      key: observationsFlowKey(lane),
      parallelism: laneParallelism(lane),
    },
    // Filterable in `qstash.logs()`, and the ONLY way our traffic is identifiable now that there is
    // no `queueName` on the wire — `queue timing` classifies by this and by the lane key.
    label: OBSERVATIONS_FLOW_PREFIX,
  });
}
