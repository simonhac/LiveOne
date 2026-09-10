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
 * Verifies QStash signatures via withQstashSignatureVerification (optional — 503s when unconfigured).
 */

import { NextRequest, NextResponse } from "next/server";
import { withQstashSignatureVerification } from "@/lib/observations/qstash-receiver";
import { eq } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { devices, sessions } from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";
import type { RawInsert, Agg5mInsert } from "@/lib/readings";
import { Point } from "@/lib/ids";
import type { PointId } from "@/lib/ids";
import type {
  QueueMessage,
  Observation,
  Session,
} from "@/lib/observations/types";
import { recompute5mForRawObservationsBestEffort } from "@/lib/db/planetscale/aggregate-points-pg";
import { isFiveMinuteNativeVendor } from "@/lib/vendors/native-intervals";
import { maxMessageObservations } from "@/lib/observations/chunk";

type Db = NonNullable<typeof planetscaleDb>;

/**
 * Cache of systemId → whether the device's vendor is 5m-native (Amber/Enphase). Vendor type is
 * effectively immutable, so caching avoids a `systems` lookup on every message. Used to decide
 * whether `insert5mObservations` UPSERTS (5m-native: late re-published refinements must overwrite)
 * or first-write-wins (raw vendors: the PG recompute owns their 5m).
 */
const fiveMinNativeCache = new Map<number, boolean>();

async function isDeviceFiveMinuteNative(
  db: Db,
  systemId: number,
): Promise<boolean> {
  const cached = fiveMinNativeCache.get(systemId);
  if (cached !== undefined) return cached;
  const rows = await db
    .select({ vendorType: devices.vendor })
    .from(devices)
    .where(eq(devices.rid, systemId))
    .limit(1);
  // Unknown device (not yet mirrored) → treat as raw-vendor (safe default; first-write-wins).
  const isNative = isFiveMinuteNativeVendor(rows[0]?.vendorType);
  fiveMinNativeCache.set(systemId, isNative);
  return isNative;
}

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
 * How a batch's observations resolved, so a failure to identify one is COUNTED rather than merely
 * folded into a generic "skipped".
 */
interface ResolveTally {
  /** Observations skipped for want of a resolvable point. */
  skipped: number;
  /** Observations carrying NO `pointUid` at all — see {@link resolvePointId}. Should always be 0. */
  noPointUid: number;
}

/**
 * Resolve an observation to its public PointId (the readings-DAO seam identity).
 *
 * config-v4 slice M retired the legacy `"{systemId}.{pointIndex}"` grammar (`debug.reference`) and its
 * producer. `obs.pointUid` is now the ONLY identity on the wire.
 *
 * **A missing `pointUid` is loud-but-skipping, deliberately.** It used to throw, which made QStash retry
 * — correct while a legacy fallback could still succeed, but with no fallback left a throw is a poison
 * pill retried forever, which is exactly what gate G3 exists to prevent. Skipping silently would be
 * data loss, so it is logged at ERROR and counted distinctly (`*NoPointUid` in the response stats), where
 * `monitor-observations` and the ingestion dashboard can see it.
 *
 * A malformed uuid is likewise an identification failure → skip. A point whose uid is well-formed but
 * unknown still fails later, inside `ReadingsDao.insertRaw`'s address resolution, and still retries.
 */
function resolvePointId(obs: Observation, tally: ResolveTally): PointId | null {
  if (obs.pointUid == null) {
    tally.noPointUid++;
    tally.skipped++;
    console.error(
      `[ObservationsReceiver] Observation has no pointUid — skipping (DATA LOSS): ${obs.topic}`,
    );
    return null;
  }
  try {
    return Point.encode(obs.pointUid);
  } catch {
    tally.skipped++;
    console.error(
      `[ObservationsReceiver] Skipping observation with malformed pointUid: ${obs.topic}`,
    );
    return null;
  }
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
): Promise<{ inserted: number; skipped: number; noPointUid: number }> {
  const tally: ResolveTally = { skipped: 0, noPointUid: 0 };
  const rows: RawInsert[] = [];

  for (const obs of observations) {
    const point = resolvePointId(obs, tally);
    if (point === null) continue;
    rows.push({
      point,
      sessionId: obs.sessionId,
      measurementTimeMs: parseTimestamp(obs.measurementTime).getTime(),
      receivedTimeMs: parseTimestamp(obs.receivedTime).getTime(),
      value: typeof obs.value === "number" ? obs.value : null,
      valueStr: typeof obs.value === "string" ? obs.value : null,
      dataQuality: "good",
    });
  }

  if (rows.length === 0) return { inserted: 0, ...tally };

  const { inserted } = await ReadingsDao.insertRaw(rows, db);
  return { inserted, ...tally };
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
  useUpsert: boolean,
): Promise<{ inserted: number; skipped: number; noPointUid: number }> {
  // Postgres self-computes raw-vendor 5m from its own raw point_readings, so the
  // publisher never sends raw-vendor 5m; a straggler that arrives must NOT be
  // inserted (it would race the recompute and is redundant). 5m-NATIVE vendors
  // (useUpsert=true, Amber/Enphase) have no raw and no recompute — the queue copy
  // IS the value — so they always keep upserting.
  if (!useUpsert) {
    console.log(
      `[ObservationsReceiver] skipping raw-vendor 5m insert for system ${systemId} (PG recomputes from raw); ${observations.length} observation(s) ignored`,
    );
    return { inserted: 0, skipped: 0, noPointUid: 0 };
  }

  const tally: ResolveTally = { skipped: 0, noPointUid: 0 };
  const rows: Agg5mInsert[] = [];

  for (const obs of observations) {
    const point = resolvePointId(obs, tally);
    if (point === null) continue;

    const intervalEndMs = parseTimestamp(obs.measurementTime).getTime();

    if (obs.agg) {
      const agg = obs.agg;
      rows.push({
        point,
        intervalEndMs,
        sessionId: obs.sessionId,
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
      // Legacy single-value payload (pre-fidelity-fix): preserve old behavior. The DAO's
      // Agg5mInsert requires every agg field, so avg/min/max/delta are set to null explicitly
      // (drizzle defaulted them to null before — same stored NULLs).
      rows.push({
        point,
        intervalEndMs,
        sessionId: obs.sessionId,
        avg: null,
        min: null,
        max: null,
        last: typeof obs.value === "number" ? obs.value : null,
        delta: null,
        valueStr: typeof obs.value === "string" ? obs.value : null,
        sampleCount: 1,
        errorCount: 0,
        dataQuality: "good",
      });
    }
  }

  if (rows.length === 0) return { inserted: 0, ...tally };

  // 5m-NATIVE vendors (useUpsert=true, Amber/Enphase): there is NO raw and NO recompute — the
  // queue copy IS the value. Amber re-publishes late `updateUsage` refinements (estimated →
  // billable), so we UPSERT to overwrite the earlier stale interval (onConflictDoNothing would
  // silently drop the refinement — see lib/vendors/native-intervals.ts). Raw vendors returned
  // above (their 5m is PG-recomputed from raw). `ReadingsDao.insert5m` mirrors this conflict
  // handling verbatim; it returns `{written}` (inserted + overwritten rows).
  const { written } = await ReadingsDao.insert5m(
    rows,
    { upsert: useUpsert },
    db,
  );
  return { inserted: written, ...tally };
}

/**
 * Insert daily aggregated observations into point_readings_agg_1d (single batched statement).
 *
 * The day key (YYYY-MM-DD) is the local date portion of `measurementTime`, which the
 * publisher sets to local midnight of the day (ISO with the device tz offset). The daily
 * table has no `sessionId`/`valueStr`/`dataQuality` columns, so those parts of the tuple
 * are ignored. Upsert (overwrite) on the PK so a day re-published after late readings
 * arrive replaces the prior aggregate.
 */
async function insert1dObservations(
  db: Db | Tx,
  systemId: number,
  observations: Observation[],
): Promise<{ inserted: number; skipped: number; noPointUid: number }> {
  // Postgres self-computes 1d from its own 5m (the daily cron), so the 1d publisher
  // is gone and no 1d should arrive. A straggler must NOT be inserted (it would
  // overwrite the PG-computed day). Unconditional no-op.
  void db;
  if (observations.length > 0) {
    console.log(
      `[ObservationsReceiver] skipping 1d insert for system ${systemId} (PG recomputes from 5m); ${observations.length} observation(s) ignored`,
    );
  }
  return { inserted: 0, skipped: 0, noPointUid: 0 };
}

/**
 * Insert session into sessions table.
 *
 * Preserves the legacy session id as the Postgres primary key so that
 * point_readings.sessionId (which carries the legacy id) joins sessions.id.
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
      // config-v4 Phase 12 terminal window: the column is `device_rid` now, FK -> `devices.rid`. The
      // value is unchanged — the handle IS the device rid (`devices.rid == systems.id` verbatim).
      deviceRid: systemId,
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
 * Accumulate a stat across sub-transactions. `stats[key] = n` would silently keep only the last
 * slice's count once a message is processed in more than one transaction.
 */
function bump(stats: Record<string, number>, key: string, n: number): void {
  // Always creates the key, including at 0 — callers only bump a stat whose table they touched,
  // and an explicit `rawInserted: 0` is meaningfully different from its absence.
  stats[key] = (stats[key] ?? 0) + n;
}

/**
 * Observations per transaction.
 *
 * Defaults to the producer's own count cap, so the two cannot drift: under normal traffic a message
 * is already <= this and there is exactly one transaction, byte-for-byte the old behaviour. The
 * slicing exists for REPLAYS — `observations_outbox` retains payloads for 30 days, so rows written
 * before the producer cap landed can still carry ~1650 observations, and a re-drive of those must
 * not hold one transaction (and its locks) open for all of them.
 */
function receiverTxObservations(): number {
  return Math.max(
    1,
    Number(
      process.env.OBSERVATIONS_RECEIVE_TX_OBSERVATIONS ??
        maxMessageObservations(),
    ),
  );
}

/**
 * Insert one slice of a message's observations, inside a single transaction.
 *
 * `withSession` is true only for the first slice, so the session row is committed before any
 * reading that references it (a `point_readings.session_id -> sessions.id` FK is coming).
 */
async function processSlice(
  db: Db,
  message: QueueMessage,
  observations: Observation[],
  withSession: boolean,
  fiveMinUpsert: boolean,
  stats: Record<string, number>,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Session first so readings can reference it (future FK).
    if (withSession && message.session) {
      await insertSession(tx, message.systemId, message.session);
      bump(stats, "sessionInserted", 1);
    }

    if (observations.length === 0) return;

    const rawObs = observations.filter((o) => o.interval === "raw");
    const agg5mObs = observations.filter((o) => o.interval === "5m");
    const agg1dObs = observations.filter((o) => o.interval === "1d");

    if (rawObs.length > 0) {
      const result = await insertRawObservations(tx, message.systemId, rawObs);
      bump(stats, "rawInserted", result.inserted);
      bump(stats, "rawSkipped", result.skipped);
      if (result.noPointUid > 0)
        bump(stats, "rawNoPointUid", result.noPointUid);
    }

    if (agg5mObs.length > 0) {
      const result = await insert5mObservations(
        tx,
        message.systemId,
        agg5mObs,
        fiveMinUpsert,
      );
      bump(stats, "agg5mInserted", result.inserted);
      bump(stats, "agg5mSkipped", result.skipped);
      if (result.noPointUid > 0)
        bump(stats, "agg5mNoPointUid", result.noPointUid);
    }

    if (agg1dObs.length > 0) {
      const result = await insert1dObservations(tx, message.systemId, agg1dObs);
      // upsert: RETURNING counts both inserted and overwritten rows.
      bump(stats, "agg1dUpserted", result.inserted);
      bump(stats, "agg1dSkipped", result.skipped);
      if (result.noPointUid > 0)
        bump(stats, "agg1dNoPointUid", result.noPointUid);
    }
  });
}

/**
 * Process the queue message and insert into PlanetScale.
 *
 * PR-7b co-enqueues a poll's session and its readings in ONE message, and a later
 * FK point_readings.session_id → sessions.id is coming. So the SESSION is inserted
 * FIRST, in the first transaction, before any reading that could reference it.
 *
 * A message is processed in slices of `receiverTxObservations()` observations, one
 * transaction each. Under normal traffic that is a single transaction — the producer
 * already caps messages at the same number — so this is the old behaviour exactly. It
 * bounds lock hold time when a pre-cap outbox row is replayed. Each slice is
 * independently idempotent (onConflictDoNothing/DoUpdate), so a failure part-way
 * through is safely retried in full.
 *
 * Dual-shape tolerant: a message may be session-only, observations-only, or combined.
 *
 * Throws on any insert error: a transaction rollback rethrows, the handler returns
 * 500, and QStash retries.
 */
async function processQueueMessage(
  db: Db,
  message: QueueMessage,
): Promise<Record<string, number>> {
  // Resolve (cached) whether this device's 5m is queue-owned (5m-native → upsert) or
  // recompute-owned (raw vendor → first-write-wins). Done outside the tx; vendor type is immutable.
  const fiveMinUpsert = await isDeviceFiveMinuteNative(db, message.systemId);

  const stats: Record<string, number> = {};
  const observations = message.observations ?? [];
  const sliceSize = receiverTxObservations();

  const slices: Observation[][] = [];
  for (let i = 0; i < observations.length; i += sliceSize) {
    slices.push(observations.slice(i, i + sliceSize));
  }
  // A session-only message still needs one (empty) pass so the session lands.
  if (slices.length === 0) slices.push([]);

  for (const [index, slice] of slices.entries()) {
    await processSlice(db, message, slice, index === 0, fiveMinUpsert, stats);
  }

  return stats;
}

/**
 * Structural validation of an untrusted message body.
 *
 * 🛑 **Retry only what retrying can fix.** Every failure in this route used to become a 500, so a
 * structurally invalid message burned its whole retry schedule — holding a delivery slot the entire
 * time — and was guaranteed to fail identically on every attempt. That is the poison-pill shape that
 * took ingest down on 2026-09-09. A body that can never parse is a PERMANENT failure: ack it, count
 * it, and let it out of the pipe. Transient failures (Postgres down, a rollback) still 500 and still
 * retry, because retrying those does fix them.
 *
 * Deliberately shallow. Per-observation problems are already handled downstream by
 * {@link resolvePointId}, which skips-and-counts rather than throwing, for exactly the same reason.
 */
function invalidMessageReason(body: unknown): string | null {
  if (body === null || typeof body !== "object") return "body is not an object";
  const message = body as Partial<QueueMessage>;
  if (
    typeof message.systemId !== "number" ||
    !Number.isFinite(message.systemId)
  ) {
    return "systemId is missing or not a number";
  }
  if (
    message.observations !== undefined &&
    !Array.isArray(message.observations)
  ) {
    return "observations is present but not an array";
  }
  if (
    message.session !== undefined &&
    (message.session === null || typeof message.session !== "object")
  ) {
    return "session is present but not an object";
  }
  return null;
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

  let body: QueueMessage;
  try {
    body = (await request.json()) as QueueMessage;
  } catch (error) {
    // Unparseable JSON can never become parseable. Ack so it does not occupy a slot for its whole
    // retry schedule; the outbox still holds the payload for 30 days if this needs investigating.
    console.error(
      "[ObservationsReceiver] permanent_failure: body is not valid JSON —",
      error,
    );
    return NextResponse.json({
      status: "rejected",
      reason: "invalid_json",
      retryable: false,
    });
  }

  const invalid = invalidMessageReason(body);
  if (invalid) {
    console.error(
      `[ObservationsReceiver] permanent_failure: ${invalid} — acking so it does not retry`,
    );
    return NextResponse.json({
      status: "rejected",
      reason: invalid,
      retryable: false,
    });
  }

  try {
    const observationCount = body.observations?.length ?? 0;
    // 🛑 The DURABLE half of per-batch timing. `lib/observations/message-log.ts` derives the same
    // span from QStash's own logs, but those age out on Upstash's retention and disappear entirely
    // when the queue is retired. This line is ours: it survives both, and it is the receiver's own
    // clock rather than a delivery round-trip, so it excludes network and cold start.
    const startedAtMs = Date.now();

    console.log(
      `[ObservationsReceiver] Received: systemId=${body.systemId}, ` +
        `observations=${observationCount}, ` +
        `session=${body.session ? "yes" : "no"}, ` +
        `batchTime=${body.batchTime}`,
    );

    // 🛑 An oversized message is REPORTED, never REJECTED. A non-2xx here would still be retried by
    // QStash and would still hold the delivery slot for the whole schedule, so rejecting buys no
    // blast-radius reduction at all — and it would be worse than nothing, because by now this
    // message's outbox row is already marked `published_at`, so a permanent rejection would turn a
    // latency problem into silent data loss. The real bound is the producer's (lib/observations/chunk.ts);
    // this only tells us when something published past it.
    const maxObservations = maxMessageObservations();
    if (observationCount > maxObservations) {
      console.error(
        `[ObservationsReceiver] oversized_message: systemId=${body.systemId} ` +
          `observations=${observationCount} exceeds the producer cap of ${maxObservations} — ` +
          "processing anyway; find the producer that is not chunking",
      );
    }

    const stats = await processQueueMessage(planetscaleDb, body);
    if (observationCount > maxObservations) stats.oversized = 1;

    // Read this against `waitMs` in `liveone queue timing`: a long wait with a short duration is
    // head-of-line blocking (something ahead held the slot), a long duration is this batch's own
    // work. Conflating them is what made 2026-09-09 look like a throughput deficit twice.
    const durationMs = Date.now() - startedAtMs;
    console.log(
      `[ObservationsReceiver] Processed in ${durationMs}ms: ${JSON.stringify(stats)}`,
    );

    // Once this message's raw readings have durably landed (tx committed above),
    // recompute the raw-vendor 5m aggregates for the touched intervals from PG's
    // own raw. Best-effort — it never throws — but awaited so the work completes
    // before the serverless function can freeze.
    //
    // 🛑 This is NOT capped, deliberately. Capping the intervals and skipping the tail would lose
    // those 5m aggregates permanently: the receiver hook is the ONLY thing that rebuilds 5m from
    // raw — no cron does it (verified 2026-09-09). Its cost is bounded at the producer instead, by
    // the message's observation cap, since a message can only touch as many intervals as it carries
    // observations.
    if (body.observations) {
      const rawObs = body.observations.filter((o) => o.interval === "raw");
      if (rawObs.length > 0) {
        await recompute5mForRawObservationsBestEffort(body.systemId, rawObs);
      }
    }

    return NextResponse.json({ status: "ok", stats });
  } catch (error) {
    console.error(`[ObservationsReceiver] Error processing message:`, error);
    // Transient by assumption (a rollback, PG going away mid-write) — 500 so QStash retries.
    // Permanent shapes were already acked above.
    return NextResponse.json(
      { status: "error", error: String(error) },
      { status: 500 },
    );
  }
}

// Verify QStash signatures when configured; a missing signing key (dev/preview) yields a 503 rather
// than throwing at module load — see withQstashSignatureVerification.
export const POST = withQstashSignatureVerification(handler);

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
  __invalidMessageReason: typeof invalidMessageReason;
};
Object.defineProperty(POST, "__processQueueMessage", {
  value: processQueueMessage,
  enumerable: false,
});
Object.defineProperty(POST, "__invalidMessageReason", {
  value: invalidMessageReason,
  enumerable: false,
});
