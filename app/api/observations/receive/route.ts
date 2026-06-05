/**
 * QStash Receiver Endpoint for Observation Batches
 *
 * Receives QueueMessage from QStash and inserts into PlanetScale PostgreSQL.
 * - Observations → point_readings (raw) or point_readings_agg_5m (5m) based on interval
 * - Sessions → sessions table
 *
 * Idempotent: raw, 5m and session inserts use .onConflictDoNothing() (first-write-wins);
 * 1d uses .onConflictDoUpdate() (overwrite, since a day can be recomputed as late readings
 * arrive). Either way re-delivery / retries are safe. Inserts are batched (one statement
 * per table per message).
 *
 * Failure handling: if anything throws — or if PlanetScale is not configured —
 * the handler returns a non-2xx so QStash retries. It must NEVER ack-and-drop,
 * because (in a later phase) Postgres becomes the system of record and a silent
 * drop would be unrecoverable.
 *
 * Uses verifySignatureAppRouter wrapper for automatic signature verification.
 */

import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
  sessions,
} from "@/lib/db/planetscale/schema";
import type {
  QueueMessage,
  Observation,
  Session,
} from "@/lib/observations/types";

type Db = NonNullable<typeof planetscaleDb>;

/**
 * The transaction handle passed to the `db.transaction(async (tx) => ...)` callback.
 * The insert helpers accept `Db | Tx` so they run either standalone or inside a tx.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Parse ISO 8601 timestamp to Date object
 */
function parseTimestamp(isoString: string): Date {
  return new Date(isoString);
}

/**
 * Extract pointId from observation debug.reference
 * Format: "{systemId}.{pointIndex}"
 */
function extractPointId(observation: Observation): number | null {
  if (!observation.debug?.reference) {
    return null;
  }
  const parts = observation.debug.reference.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const pointId = parseInt(parts[1], 10);
  return isNaN(pointId) ? null : pointId;
}

/**
 * Insert raw observations into point_readings table (single batched statement).
 * Returns the number of rows actually inserted (conflicts are skipped) and the
 * number skipped for lacking a resolvable pointId.
 */
async function insertRawObservations(
  db: Db | Tx,
  systemId: number,
  observations: Observation[],
): Promise<{ inserted: number; skipped: number }> {
  let skipped = 0;
  const rows: (typeof pointReadings.$inferInsert)[] = [];

  for (const obs of observations) {
    const pointId = extractPointId(obs);
    if (pointId === null) {
      console.warn(
        `[ObservationsReceiver] Skipping observation without valid pointId: ${obs.topic}`,
      );
      skipped++;
      continue;
    }
    rows.push({
      systemId,
      pointId,
      sessionId: obs.sessionId,
      measurementTime: parseTimestamp(obs.measurementTime),
      receivedTime: parseTimestamp(obs.receivedTime),
      value: typeof obs.value === "number" ? obs.value : null,
      valueStr: typeof obs.value === "string" ? obs.value : null,
      dataQuality: "good",
    });
  }

  if (rows.length === 0) return { inserted: 0, skipped };

  const result = await db
    .insert(pointReadings)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: pointReadings.id });

  return { inserted: result.length, skipped };
}

/**
 * Insert 5m aggregated observations into point_readings_agg_5m (single batched statement).
 *
 * Full fidelity: when the observation carries the `agg` tuple (avg/min/max/last/
 * delta/sampleCount/errorCount/valueStr/dataQuality) we store it verbatim. Legacy
 * messages published before `agg` existed fall back to the old single-value shape
 * (last = value) so any in-flight old payloads still land instead of erroring.
 */
async function insert5mObservations(
  db: Db | Tx,
  systemId: number,
  observations: Observation[],
): Promise<{ inserted: number; skipped: number }> {
  let skipped = 0;
  const rows: (typeof pointReadingsAgg5m.$inferInsert)[] = [];

  for (const obs of observations) {
    const pointId = extractPointId(obs);
    if (pointId === null) {
      console.warn(
        `[ObservationsReceiver] Skipping 5m observation without valid pointId: ${obs.topic}`,
      );
      skipped++;
      continue;
    }

    const base = {
      systemId,
      pointId,
      intervalEnd: parseTimestamp(obs.measurementTime),
      sessionId: obs.sessionId,
    };

    if (obs.agg) {
      const agg = obs.agg;
      rows.push({
        ...base,
        avg: agg.avg,
        min: agg.min,
        max: agg.max,
        last: agg.last,
        delta: agg.delta,
        valueStr: agg.valueStr,
        sampleCount: agg.sampleCount,
        errorCount: agg.errorCount,
        dataQuality: agg.dataQuality,
      });
    } else {
      // Legacy single-value payload (pre-fidelity-fix): preserve old behavior.
      rows.push({
        ...base,
        last: typeof obs.value === "number" ? obs.value : null,
        valueStr: typeof obs.value === "string" ? obs.value : null,
        sampleCount: 1,
        errorCount: 0,
        dataQuality: "good",
      });
    }
  }

  if (rows.length === 0) return { inserted: 0, skipped };

  // onConflictDoNothing (first-write-wins) keeps re-delivery idempotent and avoids
  // out-of-order upsert hazards. Re-refined 5m intervals won't propagate; that drift
  // is reconciled by the (deferred) Turso backfill while Turso remains source of truth.
  const result = await db
    .insert(pointReadingsAgg5m)
    .values(rows)
    .onConflictDoNothing()
    .returning({ systemId: pointReadingsAgg5m.systemId });

  return { inserted: result.length, skipped };
}

/**
 * Insert daily aggregated observations into point_readings_agg_1d (single batched statement).
 *
 * The day key (YYYY-MM-DD) is the local date portion of `measurementTime`, which the
 * publisher sets to local midnight of the day (ISO with the system tz offset). The daily
 * table has no `sessionId`/`valueStr`/`dataQuality` columns, so those parts of the tuple
 * are ignored. Upsert (overwrite) on the PK so a day re-published after late readings
 * arrive replaces the prior aggregate.
 */
async function insert1dObservations(
  db: Db | Tx,
  systemId: number,
  observations: Observation[],
): Promise<{ inserted: number; skipped: number }> {
  let skipped = 0;
  const rows: (typeof pointReadingsAgg1d.$inferInsert)[] = [];

  for (const obs of observations) {
    const pointId = extractPointId(obs);
    if (pointId === null || !obs.agg) {
      console.warn(
        `[ObservationsReceiver] Skipping 1d observation without valid pointId/agg: ${obs.topic}`,
      );
      skipped++;
      continue;
    }
    const agg = obs.agg;
    rows.push({
      systemId,
      pointId,
      day: obs.measurementTime.slice(0, 10),
      avg: agg.avg,
      min: agg.min,
      max: agg.max,
      last: agg.last,
      delta: agg.delta,
      sampleCount: agg.sampleCount,
      errorCount: agg.errorCount,
    });
  }

  if (rows.length === 0) return { inserted: 0, skipped };

  const result = await db
    .insert(pointReadingsAgg1d)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        pointReadingsAgg1d.systemId,
        pointReadingsAgg1d.pointId,
        pointReadingsAgg1d.day,
      ],
      set: {
        avg: sql`excluded.avg`,
        min: sql`excluded.min`,
        max: sql`excluded.max`,
        last: sql`excluded.last`,
        delta: sql`excluded.delta`,
        sampleCount: sql`excluded.sample_count`,
        errorCount: sql`excluded.error_count`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ systemId: pointReadingsAgg1d.systemId });

  return { inserted: result.length, skipped };
}

/**
 * Insert session into sessions table.
 *
 * Preserves the Turso session id as the Postgres primary key so that
 * point_readings.sessionId (which carries the Turso id) joins sessions.id.
 * The consumer always supplies an explicit id, so the serial default never
 * fires and the sequence can't collide.
 */
async function insertSession(
  db: Db | Tx,
  systemId: number,
  session: Session,
): Promise<void> {
  await db
    .insert(sessions)
    .values({
      id: session.sessionId,
      sessionLabel: session.sessionLabel,
      systemId,
      cause: session.cause,
      duration: session.durationMs,
      successful: session.successful,
      errorCode: session.errorCode,
      error: session.error,
      response: session.response,
      numRows: session.numRows,
      createdAt: parseTimestamp(session.started),
    })
    .onConflictDoNothing();
}

/**
 * Process the queue message and insert into PlanetScale.
 *
 * PR-7b co-enqueues a poll's session and its readings in ONE message, and a later
 * FK point_readings.session_id → sessions.id is coming. So all inserts for a single
 * message run in ONE transaction, with the SESSION inserted FIRST (when present) so
 * the readings never reference a not-yet-existing session row.
 *
 * Dual-shape tolerant: during rollout the old separate-message flow and the new
 * combined flow coexist, so a message may be session-only, observations-only, or
 * combined. The wrapper handles all three (session first if present, then whatever
 * observations exist).
 *
 * Throws on any insert error: a transaction rollback rethrows, the handler returns
 * 500, and QStash retries.
 */
async function processQueueMessage(
  db: Db,
  message: QueueMessage,
): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const stats: Record<string, number> = {};

    // Session first so readings can reference it (future FK).
    if (message.session) {
      await insertSession(tx, message.systemId, message.session);
      stats.sessionInserted = 1;
    }

    if (message.observations && message.observations.length > 0) {
      const rawObs = message.observations.filter((o) => o.interval === "raw");
      const agg5mObs = message.observations.filter((o) => o.interval === "5m");

      if (rawObs.length > 0) {
        const result = await insertRawObservations(
          tx,
          message.systemId,
          rawObs,
        );
        stats.rawInserted = result.inserted;
        stats.rawSkipped = result.skipped;
      }

      if (agg5mObs.length > 0) {
        const result = await insert5mObservations(
          tx,
          message.systemId,
          agg5mObs,
        );
        stats.agg5mInserted = result.inserted;
        stats.agg5mSkipped = result.skipped;
      }

      const agg1dObs = message.observations.filter((o) => o.interval === "1d");
      if (agg1dObs.length > 0) {
        const result = await insert1dObservations(
          tx,
          message.systemId,
          agg1dObs,
        );
        // upsert: RETURNING counts both inserted and overwritten rows.
        stats.agg1dUpserted = result.inserted;
        stats.agg1dSkipped = result.skipped;
      }
    }

    return stats;
  });
}

async function handler(request: NextRequest) {
  // Fail loud (retry) rather than silently dropping when Postgres isn't configured.
  if (!planetscaleDb) {
    console.error(
      "[ObservationsReceiver] Postgres not configured (set DB_* or PLANETSCALE_DATABASE_URL) — " +
        "returning 500 so QStash retries instead of dropping the message",
    );
    return NextResponse.json(
      { status: "error", error: "planetscale_not_configured" },
      { status: 500 },
    );
  }

  try {
    const body = (await request.json()) as QueueMessage;

    console.log(
      `[ObservationsReceiver] Received: systemId=${body.systemId}, ` +
        `observations=${body.observations?.length || 0}, ` +
        `session=${body.session ? "yes" : "no"}, ` +
        `batchTime=${body.batchTime}`,
    );

    const stats = await processQueueMessage(planetscaleDb, body);

    console.log(`[ObservationsReceiver] Processed: ${JSON.stringify(stats)}`);

    return NextResponse.json({ status: "ok", stats });
  } catch (error) {
    console.error(`[ObservationsReceiver] Error processing message:`, error);
    // Return 500 to trigger QStash retry
    return NextResponse.json(
      { status: "error", error: String(error) },
      { status: 500 },
    );
  }
}

// Wrap handler with signature verification using our custom env var names
export const POST = verifySignatureAppRouter(handler, {
  currentSigningKey: process.env.OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: process.env.OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY,
});

/**
 * Test-only handle on the internal message processor.
 *
 * Next.js route modules may only export the recognised route fields (POST, GET,
 * config, …) — a bare `export function processQueueMessage` (or any extra named
 * export) fails the build with "is not a valid Route export field". So instead of a
 * top-level export we hang the function off the (valid) POST export as a
 * non-enumerable property. Unit tests reach it via
 * `(POST as WithProcessQueueMessage).__processQueueMessage` without enabling any
 * extra HTTP path or extra module export.
 */
export type WithProcessQueueMessage = typeof POST & {
  __processQueueMessage: typeof processQueueMessage;
};
Object.defineProperty(POST, "__processQueueMessage", {
  value: processQueueMessage,
  enumerable: false,
});
