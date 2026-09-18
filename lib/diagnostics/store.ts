/**
 * Storage for the retained fault record: portal events, inverter events, jobs and captures.
 *
 * Everything here is idempotent on `dedupe_key`, because every source is re-read: the portal's
 * Events page returns its whole retained list on every poll, and an inverter capture deliberately
 * re-reads the previous capture's newest record as proof of overlap. Re-reading must produce one
 * row, and must still report a real TRANSITION — a fault appearing, or one that was active being
 * cleared — because that transition is what decides whether we go and look inside the inverter.
 *
 * 🛑 Conflicts are resolved with `ON CONFLICT`, never by catching a 23505: PlanetScale strips the
 * `code`/`constraint` fields off every Postgres error, so error-matching here cannot distinguish a
 * duplicate from anything else (see lib/db/pg-error.ts).
 */
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  deviceEvents,
  diagnosticCaptures,
  diagnosticJobs,
} from "@/lib/db/planetscale/schema";
import { EVENT_LOG_NAMES, type DecodedEvent } from "@/lib/selectlive/events";
import {
  isInverterEvent,
  type PortalEvent,
} from "@/lib/vendors/selectronic/portal-events";

type TriggerKind =
  | "portal-event-new"
  | "portal-event-cleared"
  | "fault-code-changed"
  | "manual"
  | "baseline";

export interface TriggerReason {
  kind: TriggerKind;
  detail: string;
  observedAt: string;
}

/**
 * A drizzle handle — the pool, or a transaction.
 *
 * Retaining an event and enqueueing the acquisition it justifies have to be ONE unit. They are a
 * read-modify-write over the same fact: the trigger is computed by diffing the page against what we
 * already store, so the moment the row is stored the transition is consumed. If the enqueue then
 * fails, or the function is killed between the two, the next poll sees an unchanged page, computes
 * no transition, and the fault's inverter evidence is never fetched — silently, and for ever.
 */
export type DiagnosticsExec = Pick<
  ReturnType<typeof requirePlanetscaleDb>,
  "select" | "insert" | "update"
>;
const exec = (db?: DiagnosticsExec): DiagnosticsExec =>
  db ?? requirePlanetscaleDb();

/**
 * A timestamp bind for a RAW `sql` fragment.
 *
 * 🛑 Handing node-pg a `Date` inside a raw fragment serialises it with the machine's LOCAL offset,
 * and a `timestamp without time zone` column then reads that as literal wall clock — correct on
 * Vercel (UTC), ten hours out on a Sydney laptop. It is not a parse error and nothing warns: the
 * comparison simply comes out wrong. Here it made `lease_expires_at <= now` true for a lease with
 * a minute still to run, so a second worker cheerfully re-claimed a job that was already running.
 *
 * The same trap, with the same remedy, is documented in `lib/polling-utils.ts`. Drizzle's TYPED
 * column setters (`.set({ nextAttemptAt: date })`) are unaffected — they go through the column's
 * own mapper. This is only for hand-written SQL.
 */
const pgTs = (at: Date) => sql`${at.toISOString()}::timestamp`;

export interface PortalIngestResult {
  inserted: number;
  cleared: number;
  /** True when this device had no stored portal events before this call. */
  baseline: boolean;
  reasons: TriggerReason[];
}

/**
 * Record what the Events page reported, and say what CHANGED.
 *
 * Baselining: the first ingest for a device stores the whole retained page but raises no trigger
 * for the old, already-cleared rows — those faults are months of history, not news, and firing an
 * acquisition for each of them would open a dozen inverter sessions to learn nothing. A fault that
 * is active right now is different, and is reported even on the first run.
 */
export async function ingestPortalEvents(
  deviceRid: number,
  events: PortalEvent[],
  timezone: string,
  observedAt: Date,
  tx?: DiagnosticsExec,
): Promise<PortalIngestResult> {
  const db = exec(tx);
  const existing = await db
    .select({
      dedupeKey: deviceEvents.dedupeKey,
      clearedTimeText: deviceEvents.clearedTimeText,
    })
    .from(deviceEvents)
    .where(
      and(
        eq(deviceEvents.deviceRid, deviceRid),
        eq(deviceEvents.source, "portal"),
      ),
    );
  const baseline = existing.length === 0;
  const known = new Map(existing.map((e) => [e.dedupeKey, e.clearedTimeText]));
  const reasons: TriggerReason[] = [];
  let inserted = 0;
  let cleared = 0;

  const rows: (typeof deviceEvents.$inferInsert)[] = [];
  for (const event of events) {
    const before = known.get(event.dedupeKey);
    const isNew = before === undefined;
    // "It was active when we last saw it and now it is not" — the clearance transition. Computed
    // from what we STORED, not from the page, so a restart cannot re-fire it.
    const nowCleared =
      !isNew && (before ?? "") === "" && event.clearedText !== "";
    rows.push({
      deviceRid,
      source: "portal",
      logType: null,
      code: event.code,
      description: event.description,
      sourceTimeText: event.createdText,
      sourceTimezone: timezone,
      occurredAt: event.createdAt,
      clearedTimeText: event.clearedText,
      clearedAt: event.clearedAt,
      observedAt,
      raw: JSON.stringify({
        code: event.code,
        description: event.description,
        created: event.createdText,
        cleared: event.clearedText,
        statusClass: event.statusClass,
      }),
      dedupeKey: event.dedupeKey,
    });
    if (!isInverterEvent(event)) continue;
    if (isNew) {
      inserted++;
      // Including one discovered ALREADY cleared: we never saw it live, so the inverter's log is
      // the only remaining account of it.
      if (!baseline || event.active)
        reasons.push({
          kind: "portal-event-new",
          detail: `${event.code} ${event.description} (created ${event.createdText}${event.active ? ", active" : ", already cleared"})`,
          observedAt: observedAt.toISOString(),
        });
    } else if (nowCleared) {
      cleared++;
      reasons.push({
        kind: "portal-event-cleared",
        detail: `${event.code} ${event.description} cleared ${event.clearedText}`,
        observedAt: observedAt.toISOString(),
      });
    }
  }

  // ONE statement for the whole page, not one per row. The page returns its entire retained list
  // every minute and is usually unchanged, so the loop version spent a round trip per row inside
  // the minutely poll's budget to write nothing.
  if (rows.length)
    await db
      .insert(deviceEvents)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          deviceEvents.deviceRid,
          deviceEvents.source,
          deviceEvents.dedupeKey,
        ],
        // A portal occurrence is ONE row for its whole life: only the clearance and our own
        // observation time move. Created never changes — if it did, it would be a different
        // occurrence with a different key.
        set: {
          clearedTimeText: sql`excluded.cleared_time_text`,
          clearedAt: sql`excluded.cleared_at`,
          description: sql`excluded.description`,
          observedAt: sql`excluded.observed_at`,
          updatedAt: new Date(),
        },
      });

  return { inserted, cleared, baseline, reasons };
}

/** Store decoded inverter events. Returns how many were genuinely new. */
export async function ingestInverterEvents(
  deviceRid: number,
  captureId: string,
  decoded: DecodedEvent[],
  timezone: string | undefined,
  occurredAtFor: (event: DecodedEvent) => Date | null,
  observedAt: Date,
): Promise<number> {
  if (!decoded.length) return 0;
  const db = requirePlanetscaleDb();
  const rows = decoded.map((event) => ({
    deviceRid,
    source: "inverter" as const,
    logType: event.log,
    code: event.code,
    description: event.description,
    sourceTimeText: event.device_time,
    sourceTimezone: timezone ?? null,
    occurredAt: occurredAtFor(event),
    observedAt,
    snapshot: event,
    raw: event.raw_hex,
    dedupeKey: event.id,
    captureId,
  }));
  // Chunked, because a first capture of both logs is ~1000 records and each row carries a decoded
  // snapshot — one statement per record is a round trip per record inside a bounded worker.
  const CHUNK = 200;
  let created = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const written = await db
      .insert(deviceEvents)
      .values(rows.slice(i, i + CHUNK))
      // Nothing to update: an inverter record is immutable bytes. A second sighting of the same
      // record is the SAME event, and the capture that first produced it keeps the attribution.
      .onConflictDoNothing({
        target: [
          deviceEvents.deviceRid,
          deviceEvents.source,
          deviceEvents.dedupeKey,
        ],
      })
      .returning({ id: deviceEvents.id });
    created += written.length;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const RETRY_LADDER_MINUTES = [1, 5, 15, 60] as const;
/** After the ladder, hourly — and after this many attempts we stop and wait for something new. */
export const MAX_ATTEMPTS = 4 + 24;

/**
 * How long to wait before the next attempt.
 *
 * 🛑 `attemptsMade` is ONE-BASED: the number of attempts INCLUDING the one that has just failed,
 * which is exactly what `claimDueJob` returns (it increments the counter as it claims). Reading it
 * as "failures so far, zero-based" is an off-by-one that silently skips the first rung — the first
 * failure then waits five minutes instead of one, which is the difference between catching the
 * inverter while an outage is still in progress and arriving after it.
 */
export function nextAttemptDelayMs(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  const rung = Math.max(1, attemptsMade) - 1;
  const minutes =
    rung < RETRY_LADDER_MINUTES.length ? RETRY_LADDER_MINUTES[rung] : 60;
  return minutes * 60 * 1000;
}

/**
 * Enqueue an acquisition, coalescing onto whatever is already open for this device.
 *
 * The inverter permits one SP LINK session, so a device has at most one open job — enforced by the
 * partial unique index, not by checking first, because overlapping cron runs make "check then
 * insert" a race. Coalescing APPENDS the reasons: "why did we go and look" is the part that cannot
 * be reconstructed afterwards, and a job that fired for three different faults must say so.
 */
export async function enqueueDiagnosticJob(
  deviceRid: number,
  reasons: TriggerReason[],
  requestedBy: "trigger" | "cli" | "baseline",
  tx?: DiagnosticsExec,
): Promise<{ jobId: string; coalesced: boolean }> {
  if (!reasons.length) throw new Error("A diagnostic job must state a reason.");
  const db = exec(tx);
  const now = new Date();
  // Minted here so the RETURNING clause can tell an insert from a conflict: the conflict branch
  // keeps the existing row's id, so getting our own id back means we created it. See below.
  const candidateId = randomUUID();
  const [row] = await db
    .insert(diagnosticJobs)
    .values({
      id: candidateId,
      deviceRid,
      status: "pending",
      reasons,
      requestedBy,
      nextAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: diagnosticJobs.deviceRid,
      targetWhere: sql`status IN ('pending','running')`,
      set: {
        reasons: sql`${diagnosticJobs.reasons} || ${JSON.stringify(reasons)}::jsonb`,
        updatedAt: now,
        // A transition that arrives while an acquisition is RUNNING must not shorten its lease or
        // pull its schedule forward — the follow-up is scheduled when that attempt finishes.
        nextAttemptAt: sql`LEAST(${diagnosticJobs.nextAttemptAt}, ${pgTs(now)})`,
        /**
         * 🛑 New work gets a fresh ladder — and the window that matters is BACKOFF, not execution.
         *
         * `finishJob` already resets `attempts` for a reason that lands mid-acquisition, but that
         * is the 40-second window. The long one is the wait between attempts: a device unreachable
         * for a day sits `pending` with 27 failures behind it, and a brand-new fault appended to
         * that job would inherit them — one attempt, then abandoned. The ladder measures how long
         * THIS request has been failing, so a request that has just arrived starts at zero.
         *
         * Only for a `pending` job. Resetting a `running` one would leave the in-flight worker
         * holding a stale count, and `finishJob`'s late-reason path already covers that case.
         */
        attempts: sql`CASE WHEN ${diagnosticJobs.status} = 'pending' THEN 0 ELSE ${diagnosticJobs.attempts} END`,
      },
    })
    .returning({ id: diagnosticJobs.id });
  /**
   * 🛑 Did this request CREATE the job or join one?
   *
   * Two wrong answers were tried first, and both are worth naming. `attempts > 0` broke the moment
   * a coalesce onto a pending job started resetting the counter — it reported a fresh insert for
   * exactly the case the flag exists to surface. Comparing `created_at` to `updated_at` then broke
   * on a tie: `now()` is transaction-start time so an insert's two defaults do match, but the
   * conflict branch writes a JavaScript `new Date()` which can land on the same millisecond as the
   * existing row's creation.
   *
   * Minting the id client-side settles it without clock assumptions or tuple-header tricks: the
   * conflict branch preserves the existing row's id, so getting our own back means we inserted.
   */
  return { jobId: row.id, coalesced: row.id !== candidateId };
}

export interface ClaimedJob {
  id: string;
  deviceRid: number;
  reasons: TriggerReason[];
  attempts: number;
  requestedBy: string;
  /** The fencing token for THIS claim. `finishJob` will not write without it. */
  leaseToken: string;
  /** How many reasons the job carried at claim time. A reason appended while the acquisition was
   * running arrived too late for it, and must schedule a follow-up rather than be marked done. */
  reasonsAtClaim: number;
}

/**
 * Take one due job, under an expiring lease.
 *
 * The lease, not a status flag, is what makes this safe: a Vercel function can vanish mid-
 * acquisition, and a job stuck in `running` with no way back would silently never run again. An
 * expired lease is reclaimable; a live one is respected.
 */
export async function claimDueJob(
  leaseMs: number,
  now = new Date(),
): Promise<ClaimedJob | null> {
  const db = requirePlanetscaleDb();
  const leaseToken = randomUUID();
  const [row] = await db
    .update(diagnosticJobs)
    .set({
      status: "running",
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      leaseToken,
      attempts: sql`${diagnosticJobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      sql`${diagnosticJobs.id} = (
        SELECT id FROM ${diagnosticJobs}
        WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ${pgTs(now)}))
           OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${pgTs(now)})
        ORDER BY next_attempt_at ASC NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning({
      id: diagnosticJobs.id,
      deviceRid: diagnosticJobs.deviceRid,
      reasons: diagnosticJobs.reasons,
      attempts: diagnosticJobs.attempts,
      requestedBy: diagnosticJobs.requestedBy,
    });
  if (!row) return null;
  const reasons = (row.reasons ?? []) as TriggerReason[];
  return {
    id: row.id,
    deviceRid: row.deviceRid,
    reasons,
    attempts: row.attempts,
    requestedBy: row.requestedBy,
    leaseToken,
    reasonsAtClaim: reasons.length,
  };
}

/**
 * Close out one attempt — but only if we still hold the lease, and only if nothing new came in.
 *
 * 🛑 Three guards, and each exists because something can move underneath a bounded worker:
 *
 *  - **Fencing.** Every write matches `lease_token`. A worker that outran its lease, or that was
 *    merely slow between the acquisition and this call, would otherwise clear the lease of the
 *    worker that reclaimed the job, or mark done a second attempt that is still running. Matching
 *    the token makes a superseded write affect zero rows instead of the wrong ones.
 *  - **Late reasons.** A fault that transitions WHILE an acquisition is running appends its reason
 *    to the same job (that is the coalescing design), but arrives too late for the read already in
 *    flight. Every outcome therefore checks the reason count first: if it grew, the job goes back
 *    to `pending` for an immediate follow-up rather than being marked done — OR abandoned. The
 *    abandon path matters just as much: a job that has exhausted its ladder still consumes any
 *    trigger appended to it, and a brand-new fault must not be thrown away because the previous
 *    one had been failing for a day.
 *  - **A fresh budget for new work.** A follow-up scheduled by a late reason resets `attempts`.
 *    The ladder measures how long THIS request has been failing; inheriting 27 prior failures
 *    would give a just-arrived fault one attempt and then silence.
 */
export async function finishJob(
  jobId: string,
  outcome: {
    status: "done" | "failed" | "abandoned";
    error?: string;
    /** Required for `failed`: the attempt count `claimDueJob` returned. */
    attempts?: number;
    leaseToken: string;
    /** How many reasons the job carried at claim time. */
    reasonsAtClaim: number;
  },
): Promise<{ written: boolean; followUp: boolean }> {
  const db = requirePlanetscaleDb();
  const now = new Date();
  const held = and(
    eq(diagnosticJobs.id, jobId),
    eq(diagnosticJobs.leaseToken, outcome.leaseToken),
  )!;
  /** Nothing arrived while we worked. */
  const unchanged = sql`jsonb_array_length(${diagnosticJobs.reasons}) <= ${outcome.reasonsAtClaim}`;

  const settled =
    outcome.status === "failed"
      ? ((delay) =>
          delay === null
            ? {
                status: "abandoned" as const,
                lastError: outcome.error ?? null,
                leaseExpiresAt: null,
                leaseToken: null,
                nextAttemptAt: null,
                updatedAt: now,
              }
            : {
                // Back to `pending`, so the open-job index still holds it and a new transition
                // coalesces onto it instead of racing a second acquisition.
                status: "pending" as const,
                lastError: outcome.error ?? null,
                leaseExpiresAt: null,
                leaseToken: null,
                nextAttemptAt: new Date(now.getTime() + delay),
                updatedAt: now,
              })(nextAttemptDelayMs(outcome.attempts ?? 1))
      : {
          status: outcome.status,
          lastError:
            outcome.status === "abandoned" ? (outcome.error ?? null) : null,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: null,
          updatedAt: now,
        };

  const written = await db
    .update(diagnosticJobs)
    .set(settled)
    .where(and(held, unchanged))
    .returning({ id: diagnosticJobs.id });
  if (written.length) return { written: true, followUp: false };

  // Either the lease is no longer ours, or a reason arrived after we claimed. The follow-up write
  // is still fenced, so a lost lease affects zero rows and we report that honestly.
  const followUp = await db
    .update(diagnosticJobs)
    .set({
      status: "pending",
      lastError: outcome.error ?? null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: now,
      attempts: 0,
      updatedAt: now,
    })
    .where(held)
    .returning({ id: diagnosticJobs.id });
  return { written: followUp.length > 0, followUp: followUp.length > 0 };
}

export async function openJobFor(deviceRid: number) {
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select()
    .from(diagnosticJobs)
    .where(
      and(
        eq(diagnosticJobs.deviceRid, deviceRid),
        inArray(diagnosticJobs.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Captures and reads
// ---------------------------------------------------------------------------

export type CaptureInsert = typeof diagnosticCaptures.$inferInsert;

export async function insertCapture(values: CaptureInsert): Promise<string> {
  const db = requirePlanetscaleDb();
  const [row] = await db
    .insert(diagnosticCaptures)
    .values(values)
    .returning({ id: diagnosticCaptures.id });
  return row.id;
}

export async function updateCapture(
  id: string,
  values: Partial<CaptureInsert>,
): Promise<void> {
  await requirePlanetscaleDb()
    .update(diagnosticCaptures)
    .set(values)
    .where(eq(diagnosticCaptures.id, id));
}

/**
 * Where each log may be resumed from: the newest record of the newest COMPLETE capture of it.
 *
 * 🛑 An anchor is a claim that everything newer than it is already held, and only a completed walk
 * establishes that. Deriving it from the newest stored EVENT quietly broke exactly when it
 * mattered: a first acquisition that read the newest 100 of 500 records and then hit its
 * 40-second budget stored those 100, so the retry took the oldest-read of them as its anchor, met
 * it on the first batch, and reported success. The other 400 were never fetched and nothing would
 * ever look for them again.
 *
 * So anchors come from `diagnostic_captures.coverage.logs[log].anchor`, which `acquireDiagnostics`
 * writes only AFTER a log's walk completed and its events were ingested.
 *
 * 🛑 One query PER LOG, each asking the database for the newest capture that QUALIFIES — not a page
 * of recent captures filtered afterwards. An outage produces a run of failed and partial captures,
 * and any fixed window would let the last good anchor scroll off the end of it. Losing an anchor is
 * not merely slow: the next walk is `not-incremental`, so if those records have since been
 * overwritten the gap is never reported at all.
 */
export async function resumeAnchors(
  deviceRid: number,
): Promise<Record<string, { deviceSeconds: number; id: string }>> {
  const db = requirePlanetscaleDb();
  const anchors: Record<string, { deviceSeconds: number; id: string }> = {};
  for (const log of EVENT_LOG_NAMES) {
    const [row] = await db
      .select({
        anchor: sql<{
          deviceSeconds?: number;
          id?: string;
        } | null>`${diagnosticCaptures.coverage} -> 'logs' -> ${log} -> 'anchor'`,
      })
      .from(diagnosticCaptures)
      .where(
        and(
          eq(diagnosticCaptures.deviceRid, deviceRid),
          sql`${diagnosticCaptures.coverage} -> 'logs' -> ${log} ->> 'complete' = 'true'`,
          sql`jsonb_typeof(${diagnosticCaptures.coverage} -> 'logs' -> ${log} -> 'anchor') = 'object'`,
        ),
      )
      .orderBy(desc(diagnosticCaptures.startedAt))
      .limit(1);
    const anchor = row?.anchor;
    if (
      anchor &&
      typeof anchor.deviceSeconds === "number" &&
      typeof anchor.id === "string"
    )
      anchors[log] = { deviceSeconds: anchor.deviceSeconds, id: anchor.id };
  }
  return anchors;
}

export interface EventQuery {
  deviceRid: number;
  source?: "portal" | "inverter";
  since?: Date;
  until?: Date;
  /** Only the events one capture produced. Exact, and unaffected by `limit` ordering. */
  captureId?: string;
  limit?: number;
}

export async function listDeviceEvents(query: EventQuery) {
  const db = requirePlanetscaleDb();
  const filters = [eq(deviceEvents.deviceRid, query.deviceRid)];
  if (query.source) filters.push(eq(deviceEvents.source, query.source));
  if (query.captureId)
    filters.push(eq(deviceEvents.captureId, query.captureId));
  // A row with no usable `occurred_at` (an ambiguous or unreadable source timestamp) is still
  // evidence, so a window keeps it rather than dropping it silently.
  if (query.since)
    filters.push(
      or(
        gte(deviceEvents.occurredAt, query.since),
        sql`${deviceEvents.occurredAt} IS NULL`,
      )!,
    );
  if (query.until)
    filters.push(
      or(
        lte(deviceEvents.occurredAt, query.until),
        sql`${deviceEvents.occurredAt} IS NULL`,
      )!,
    );
  return (
    db
      .select()
      .from(deviceEvents)
      .where(and(...filters))
      .orderBy(desc(deviceEvents.occurredAt), asc(deviceEvents.source))
      // A capture's own events are bounded by the capture (a full first acquisition of both logs is
      // ~1000 records), so asking for one is not a page of the device's timeline and must not be
      // truncated by the timeline's default.
      .limit(Math.min(query.limit ?? (query.captureId ? 5000 : 200), 5000))
  );
}

export async function listCaptures(deviceRid: number, limit = 50) {
  const db = requirePlanetscaleDb();
  return db
    .select({
      id: diagnosticCaptures.id,
      jobId: diagnosticCaptures.jobId,
      startedAt: diagnosticCaptures.startedAt,
      finishedAt: diagnosticCaptures.finishedAt,
      complete: diagnosticCaptures.complete,
      recordCount: diagnosticCaptures.recordCount,
      newRecordCount: diagnosticCaptures.newRecordCount,
      decoderVersion: diagnosticCaptures.decoderVersion,
      coverage: diagnosticCaptures.coverage,
      sha256: diagnosticCaptures.sha256,
      error: diagnosticCaptures.error,
    })
    .from(diagnosticCaptures)
    .where(eq(diagnosticCaptures.deviceRid, deviceRid))
    .orderBy(desc(diagnosticCaptures.startedAt))
    .limit(Math.min(limit, 500));
}

export async function getCapture(deviceRid: number, id: string) {
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select()
    .from(diagnosticCaptures)
    .where(
      and(
        eq(diagnosticCaptures.deviceRid, deviceRid),
        eq(diagnosticCaptures.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}
