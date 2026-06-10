/**
 * Observations outbox — the transactional "PG bin before the queue" (Phase 4).
 *
 * `persistOutbox()` durably records each built QueueMessage in Postgres, in
 * parallel with (a tee of) the live direct enqueue. `drainOutbox()` — the relay,
 * run by the minutely `app/api/cron/relay-outbox` cron — republishes unpublished
 * rows to QStash and marks them published once QStash accepts them, so an enqueue
 * that was swallowed or lost to a crash is retried from a committed row instead of
 * vanishing. This is what makes raw readings durable on Postgres without relying on
 * the inline Turso write. See docs/architecture/engine-web-separation.md §6.4 and
 * docs/turso-pg-migration.md Phase 4.
 *
 * Both functions are best-effort and never throw: the outbox is additive
 * durability and must never break a poll or a cron. Republishing is idempotent —
 * the receiver dedups (onConflictDoNothing/DoUpdate) and the 5m recompute is
 * order-independent — so at-least-once redelivery (e.g. a relay timeout after a
 * QStash send but before the row is marked) converges with no duplicate data.
 */

import { and, eq, isNull, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  observationsOutbox,
  type NewObservationsOutbox,
} from "@/lib/db/planetscale/schema";
import {
  qstash,
  OBSERVATIONS_QUEUE_NAME,
  getObservationsReceiverUrl,
} from "@/lib/qstash";
import { QueueMessage } from "./types";

/** Max rows a single relay run drains. A backlog spills to the next minute. */
const DEFAULT_BATCH = Number(process.env.OUTBOX_RELAY_BATCH ?? 200);
/** Retention for published rows (audit/replay) before GC. */
const GC_DAYS = Number(process.env.OUTBOX_GC_DAYS ?? 7);

/**
 * Map built QueueMessage(s) to outbox rows. One row per message (chunk); `seq`
 * orders chunks within a poll, `session_id` comes from the message's session
 * (null for the no-collector publishObservationBatch path). Pure — no I/O.
 */
export function buildOutboxRows(
  messages: QueueMessage[],
): NewObservationsOutbox[] {
  return messages.map((message, seq) => ({
    systemId: message.systemId,
    sessionId: message.session?.sessionId ?? null,
    seq,
    payload: message,
  }));
}

/**
 * Durably record a poll's built QueueMessage(s) in the outbox. Best-effort — a
 * persist failure is logged but never breaks the poll. Idempotent on republish
 * via the partial unique `(system_id, session_id, seq)` (poll-path rows only).
 */
export async function persistOutbox(messages: QueueMessage[]): Promise<void> {
  if (!planetscaleDb || messages.length === 0) return;
  try {
    await planetscaleDb
      .insert(observationsOutbox)
      .values(buildOutboxRows(messages))
      .onConflictDoNothing();
  } catch (error) {
    console.error(
      `[Outbox] persist failed for system ${messages[0]?.systemId}:`,
      error,
    );
  }
}

export interface DrainResult {
  /** Rows claimed and attempted this run. */
  claimed: number;
  /** Rows successfully enqueued to QStash and marked published. */
  published: number;
  /** Rows whose enqueue failed (left unpublished for the next run). */
  failed: number;
  /** Unpublished rows remaining after this run. */
  backlog: number;
  /** Published rows garbage-collected this run. */
  gced: number;
}

/**
 * The relay: drain unpublished outbox rows → QStash → the existing receiver.
 *
 * Each row is claimed and published in its own short transaction with
 * `FOR UPDATE SKIP LOCKED`, so overlapping relay runs never double-claim a row
 * and locks are held only across a single enqueue. A `seen` set excludes rows
 * already attempted this run, so a row whose enqueue fails (stays unpublished)
 * is retried next minute, not re-picked in a tight loop now. Best-effort — never
 * throws; returns counters for the cron/monitoring to report.
 */
export async function drainOutbox(limit = DEFAULT_BATCH): Promise<DrainResult> {
  const result: DrainResult = {
    claimed: 0,
    published: 0,
    failed: 0,
    backlog: 0,
    gced: 0,
  };

  const db = planetscaleDb;
  if (!db || !qstash) return result;
  const receiverUrl = getObservationsReceiverUrl();
  if (!receiverUrl) return result;

  const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
  const seen = new Set<number>();

  while (result.claimed < limit) {
    let claimedOne: boolean;
    try {
      claimedOne = await db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: observationsOutbox.id,
            payload: observationsOutbox.payload,
          })
          .from(observationsOutbox)
          .where(
            and(
              isNull(observationsOutbox.publishedAt),
              seen.size > 0
                ? notInArray(observationsOutbox.id, [...seen])
                : undefined,
            ),
          )
          .orderBy(observationsOutbox.createdAt)
          .limit(1)
          .for("update", { skipLocked: true });

        const row = rows[0];
        if (!row) return false;
        seen.add(row.id);
        result.claimed++;

        try {
          await queue.enqueueJSON({
            url: receiverUrl,
            body: row.payload as QueueMessage,
          });
          await tx
            .update(observationsOutbox)
            .set({
              publishedAt: sql`now()`,
              attempts: sql`${observationsOutbox.attempts} + 1`,
            })
            .where(eq(observationsOutbox.id, row.id));
          result.published++;
        } catch (err) {
          await tx
            .update(observationsOutbox)
            .set({
              attempts: sql`${observationsOutbox.attempts} + 1`,
              lastError: String(err).slice(0, 1000),
            })
            .where(eq(observationsOutbox.id, row.id));
          result.failed++;
        }
        return true;
      });
    } catch (err) {
      // A transaction-level failure (e.g. the DB went away mid-drain). Don't
      // spin: stop this run, leave rows unpublished for the next minute.
      console.error("[Outbox] relay drain transaction failed:", err);
      break;
    }

    if (!claimedOne) break;
  }

  // Remaining backlog (for monitoring) + GC of old published rows. Best-effort.
  try {
    const [row] = await db
      .select({ backlog: sql<number>`count(*)::int` })
      .from(observationsOutbox)
      .where(isNull(observationsOutbox.publishedAt));
    result.backlog = Number(row?.backlog ?? 0);
  } catch (err) {
    console.error("[Outbox] backlog count failed:", err);
  }

  try {
    const gc = await db
      .delete(observationsOutbox)
      .where(
        and(
          isNotNull(observationsOutbox.publishedAt),
          lt(
            observationsOutbox.publishedAt,
            sql`now() - make_interval(days => ${GC_DAYS})`,
          ),
        ),
      )
      .returning({ id: observationsOutbox.id });
    result.gced = gc.length;
  } catch (err) {
    console.error("[Outbox] gc failed:", err);
  }

  return result;
}
