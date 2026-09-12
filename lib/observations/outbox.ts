/**
 * Observations outbox — the transactional "PG bin before the queue" (Phase 4).
 *
 * `persistOutbox()` durably records each built QueueMessage in Postgres, in
 * parallel with (a tee of) the live direct enqueue. `drainOutbox()` — the relay,
 * run by the minutely `app/api/cron/relay-outbox` cron — republishes unpublished
 * rows to QStash and marks them published once QStash accepts them, so an enqueue
 * that was swallowed or lost to a crash is retried from a committed row instead of
 * vanishing. This is what makes raw readings durable on Postgres. See
 * docs/architecture/engine-web-separation.md §6.4.
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
import { qstash, getObservationsReceiverUrl } from "@/lib/qstash";
import { QueueMessage } from "./types";
import { publishObservationMessage } from "./publish";

/** Max rows a single relay run drains. A backlog spills to the next minute. */
const DEFAULT_BATCH = Number(process.env.OUTBOX_RELAY_BATCH ?? 200);
/**
 * Retention for published rows (audit/replay) before GC.
 *
 * 30 days (was 7) so the config-v4 cutover's post-resume revert stays viable for the whole period the
 * `_old` hot tables are retained. Reverting means renaming `_old` back and re-driving the outbox
 * (`UPDATE observations_outbox SET published_at = NULL WHERE published_at >= <resume>`), which only works
 * while those rows still exist — 7 days was tighter than the validation window.
 */
const GC_DAYS = Number(process.env.OUTBOX_GC_DAYS ?? 30);

/**
 * Map built QueueMessage(s) to outbox rows. One row per message (chunk); `seq`
 * orders chunks within a poll, `session_id` comes from the message's session
 * (null for the no-collector publishObservationBatch path). Pure — no I/O.
 */
export function buildOutboxRows(
  messages: QueueMessage[],
): NewObservationsOutbox[] {
  return messages.map((message, seq) => ({
    // config-v4 Phase 12 terminal window: the column is `device_rid` now. Rename only — NO FK, and none
    // is to be added: an FK on a buffer would turn a device delete into an ingest-path failure.
    deviceRid: message.systemId,
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
          // The lane rides in the payload, so a replayed row lands in the same lane it was
          // published on. Pre-lane rows have none and default to live — correct, they are all polls.
          await publishObservationMessage(row.payload as QueueMessage);
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

// ---------------------------------------------------------------------------
// Reading the outbox — why publishing failed
// ---------------------------------------------------------------------------

/** One row the relay could not publish, with the reason it recorded. */
interface OutboxFailure {
  id: number;
  deviceRid: number;
  createdAt: string;
  attempts: number;
  /** `observations_outbox.last_error` — the publish exception, verbatim. */
  lastError: string | null;
  observations: number | null;
  lane: string | null;
}

export interface OutboxHealth {
  /** Rows the relay has not yet published. A steady single-digit number is normal. */
  backlog: number;
  oldestUnpublishedAt: string | null;
  oldestAgeMinutes: number | null;
  /**
   * Unpublished rows that have been TRIED and failed. The number that matters.
   *
   * A backlog of rows with `attempts: 0` is just the relay not having run yet; a backlog with
   * attempts and a `lastError` is publishing being broken, and they need telling apart at a glance.
   */
  failing: number;
  published24h: number;
  /** Newest first. Capped — one reason repeated 200 times is one finding. */
  failures: OutboxFailure[];
  /** Distinct `lastError` strings across the failing rows, most frequent first. */
  reasons: { error: string; count: number }[];
}

/**
 * Why is publishing failing?
 *
 * 🛑 This exists because the answer was already being RECORDED and could not be READ. The relay
 * writes `last_error` on every failed publish, and until 2026-09-10 nothing surfaced that column —
 * not the CLI, not `monitor-observations`, not the admin stats route, which counts the backlog and
 * drops the reason. When the flow-control cutover failed on prod, the outbox held the exception and
 * the only way to it was the Vercel dashboard.
 *
 * The backlog alone cannot answer it: an unpublished row means "not yet published", which is the
 * normal steady state between relay runs. `attempts > 0` with a `lastError` is the difference
 * between a queue that is merely behind and one that is broken.
 */
export async function readOutboxHealth(limit = 20): Promise<OutboxHealth> {
  const db = planetscaleDb;
  const empty: OutboxHealth = {
    backlog: 0,
    oldestUnpublishedAt: null,
    oldestAgeMinutes: null,
    failing: 0,
    published24h: 0,
    failures: [],
    reasons: [],
  };
  if (!db) return empty;

  const [summary] = await db
    .execute<{
      backlog: number;
      oldest_at: Date | null;
      failing: number;
      published_24h: number;
    }>(
      sql`
    SELECT
      (SELECT count(*)::int FROM observations_outbox WHERE published_at IS NULL) AS backlog,
      (SELECT min(created_at) FROM observations_outbox WHERE published_at IS NULL) AS oldest_at,
      (SELECT count(*)::int FROM observations_outbox
         WHERE published_at IS NULL AND attempts > 0) AS failing,
      (SELECT count(*)::int FROM observations_outbox
         WHERE published_at >= now() - interval '24 hours') AS published_24h
  `,
    )
    .then((r) => (r.rows ?? []) as never[]);

  const s = (summary ?? {}) as {
    backlog?: number;
    oldest_at?: Date | null;
    failing?: number;
    published_24h?: number;
  };
  const oldest = s.oldest_at ? new Date(s.oldest_at) : null;

  // Only rows that have actually been attempted — an untried backlog has no reason to report.
  const rows = await db
    .select({
      id: observationsOutbox.id,
      deviceRid: observationsOutbox.deviceRid,
      createdAt: observationsOutbox.createdAt,
      attempts: observationsOutbox.attempts,
      lastError: observationsOutbox.lastError,
      payload: observationsOutbox.payload,
    })
    .from(observationsOutbox)
    .where(and(isNull(observationsOutbox.publishedAt), sql`attempts > 0`))
    .orderBy(sql`created_at DESC`)
    .limit(limit);

  const failures: OutboxFailure[] = rows.map((r) => {
    const payload = r.payload as QueueMessage | null;
    return {
      id: Number(r.id),
      deviceRid: r.deviceRid,
      createdAt: new Date(r.createdAt).toISOString(),
      attempts: r.attempts,
      lastError: r.lastError,
      observations: payload?.observations?.length ?? null,
      lane: payload?.lane ?? null,
    };
  });

  const byReason = new Map<string, number>();
  for (const f of failures) {
    if (!f.lastError) continue;
    byReason.set(f.lastError, (byReason.get(f.lastError) ?? 0) + 1);
  }

  return {
    backlog: Number(s.backlog ?? 0),
    oldestUnpublishedAt: oldest ? oldest.toISOString() : null,
    oldestAgeMinutes: oldest
      ? Math.round(((Date.now() - oldest.getTime()) / 60_000) * 10) / 10
      : null,
    failing: Number(s.failing ?? 0),
    published24h: Number(s.published_24h ?? 0),
    failures,
    reasons: [...byReason.entries()]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count),
  };
}
