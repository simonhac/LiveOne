import { eq, sql } from "drizzle-orm";
import { transformForStorage } from "@/lib/json";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as pgDevices,
  deviceState as pgDeviceState,
} from "@/lib/db/planetscale/schema";

/**
 * Get the last polling status for a device, by its legacy integer handle.
 *
 * Reads `device_state` (config-v4 Phase 12 slice C — `polling_status` is frozen until slice N
 * drops it). The handle bridges via the verbatim-rid invariant `devices.rid == systems.id`.
 */
export async function getPollingStatus(systemId: number) {
  const [row] = await requirePlanetscaleDb()
    .select({ state: pgDeviceState })
    .from(pgDeviceState)
    .innerJoin(pgDevices, eq(pgDevices.id, pgDeviceState.deviceId))
    .where(eq(pgDevices.rid, systemId))
    .limit(1);
  return row?.state ?? null;
}

/**
 * Update polling status after a successful poll.
 *
 * ⚠️ `pollStartedAt` is the instant the poll BEGAN, not the instant it finished. The slot scheduler
 * (`lib/vendors/schedule.ts`) asks which slot a poll belongs to, and a poll that starts at 10:04:58
 * and finishes at 10:05:02 belongs to the 10:00 slot — stamping the completion time recorded it
 * into 10:05 and silently suppressed that slot's poll. It also makes `device_state.last_poll_time`
 * agree with `sessions.created_at`, which it previously did not (they differed by the poll's
 * duration, ~1-3s normally and 32s for a Sigenergy 502).
 */
export async function updatePollingStatusSuccess(
  systemId: number,
  responseData: any,
  pollStartedAt: Date,
): Promise<PreviousPollState | null> {
  const now = pollStartedAt;

  // ⚠️  CRITICAL: Transform response data before storage
  //
  // The responseData may contain objects like CalendarDate, Date, or fields ending in *TimeMs
  // that need to be converted to JSON-serializable formats before storage.
  //
  // transformForStorage() from @/lib/json will:
  // - Convert CalendarDate objects → ISO8601 date strings (YYYY-MM-DD)
  // - Convert Date objects → ISO8601 datetime strings with timezone
  // - Convert *TimeMs fields → Rename (remove "Ms") and format as ISO8601
  // - Preserve string values unchanged (including whitespace)
  const transformedResponse = responseData
    ? transformForStorage(responseData)
    : null;

  // The counter increment is ATOMIC in the upsert — `total_polls + 1` is computed from the existing
  // row inside ON CONFLICT (no read-then-write), so concurrent polls can't lose increments.
  return writeDeviceStateSuccessPg(systemId, now, transformedResponse);
}

/**
 * The device's state as it was just BEFORE a successful poll was recorded — what the recovery
 * notice (`lib/monitoring/recovery.ts`) needs to tell "back after ten hours" from an ordinary poll.
 */
export interface PreviousPollState {
  /** The previous successful poll, epoch-ms; null = this is the first one ever. */
  prevSuccessMs: number | null;
  /** Failed polls in a row before this success. */
  prevConsecutiveErrors: number;
}

/**
 * Update polling status after an error.
 */
export async function updatePollingStatusError(
  systemId: number,
  error: Error | string,
  responseData: any,
  pollStartedAt: Date,
) {
  const now = pollStartedAt;
  const errorMessage = error instanceof Error ? error.message : error;

  // Transform response data if provided (same as success case)
  const transformedResponse = responseData
    ? transformForStorage(responseData)
    : null;

  // `consecutive_errors` and `total_polls` increment atomically in the upsert.
  await writeDeviceStateErrorPg(
    systemId,
    now,
    errorMessage,
    transformedResponse,
  );
}

// ============================================================================
// device_state — the sole operational-state writer (config-v4 Phase 12 slice C).
//
// `polling_status` is FROZEN, not dropped: it holds the pre-flip state verbatim as the rollback
// snapshot until slice N drops it. Nothing writes it and nothing reads it. Do not resurrect the
// write to "keep it warm" — that is a full vendor-payload jsonb write per poll per device for a
// table no code touches. A rollback is redeploy-the-previous-build, nothing more: it resumes
// reading/writing polling_status, stale by the length of the flip, which makes boundary-scheduled
// vendors over-poll (never under-poll) and self-heals within a tick. Do NOT reach for
// scripts/config-v4/reconcile-device-state.ts to "sync back" — it only copies
// polling_status → device_state, the wrong way now, and it refuses --commit once the flip is live.
//
// LOG-BUT-DON'T-THROW: a PG write failure here is caught and logged, never rethrown. This runs from
// the poll's shouldPoll path; if it threw, the caller would treat the poll as failed and re-poll,
// minting a duplicate session.
//
// Hand-written SQL, not the drizzle builder, because the device is resolved in the SAME statement
// (`devices.rid = systemId`, an index-only probe of devices_rid_unique) rather than in a second
// round trip on the ingest hot path. Deliberately NOT via DeviceRegistry.addrForHandle: that is an
// uncached extra query AND it throws UnknownDeviceIdError, which would breach the
// LOG-BUT-DON'T-THROW contract above. Here a device with no device row inserts 0 rows, silently.
//
// ⚠️ Timestamps are passed as `toISOString()` + an explicit `::timestamp` cast. Handing node-pg a
// Date serialises it with the *local* UTC offset, which a `timestamp without time zone` column then
// takes as literal wall clock — correct on Vercel (UTC), 10 hours out on a Sydney laptop.
//
// ⚠️ The atomic counters reference device_state's OWN columns. Copying the polling_status
// expressions across would emit `polling_status.total_polls + 1` inside an INSERT INTO device_state
// — the most likely silent bug in this slice.
// ============================================================================

/** jsonb bind for a transformed vendor response (null stays SQL NULL, not the string "null"). */
function jsonbParam(transformedResponse: unknown) {
  return transformedResponse === null || transformedResponse === undefined
    ? sql`NULL::jsonb`
    : sql`${JSON.stringify(transformedResponse)}::jsonb`;
}

/**
 * Record a successful poll, returning the state it replaced (null when there was no prior row or the
 * write failed).
 *
 * The previous values come from a CTE over the same statement's snapshot, so reading them costs no
 * extra round trip. Deliberately no `FOR UPDATE`: locking a row the same statement then upserts
 * risks "tuple already modified by an operation triggered by the current command". The cost is that
 * two successful polls of one device racing each other could BOTH see the stale state — which the
 * slot scheduler makes vanishingly rare, and whose only consequence is a duplicated recovery notice.
 */
async function writeDeviceStateSuccessPg(
  systemId: number,
  now: Date,
  transformedResponse: unknown,
): Promise<PreviousPollState | null> {
  const ts = now.toISOString();
  const response = jsonbParam(transformedResponse);
  try {
    const result = (await requirePlanetscaleDb().execute(sql`
      WITH prev AS (
        SELECT (extract(epoch FROM ds.last_success_time) * 1000)::bigint AS prev_success_ms,
               ds.consecutive_errors AS prev_consecutive_errors
        FROM device_state ds
        JOIN devices d ON d.id = ds.device_id
        WHERE d.rid = ${systemId}
      ), upserted AS (
        INSERT INTO device_state (
          device_id, last_poll_time, last_success_time, last_error, last_response,
          consecutive_errors, total_polls, successful_polls, updated_at
        )
        SELECT d.id, ${ts}::timestamp, ${ts}::timestamp, NULL, ${response}, 0, 1, 1, ${ts}::timestamp
        FROM devices d
        WHERE d.rid = ${systemId}
        ON CONFLICT (device_id) DO UPDATE SET
          last_poll_time = ${ts}::timestamp,
          last_success_time = ${ts}::timestamp,
          last_error = NULL,
          last_response = ${response},
          consecutive_errors = 0,
          total_polls = device_state.total_polls + 1,
          successful_polls = device_state.successful_polls + 1,
          updated_at = ${ts}::timestamp
        RETURNING 1
      )
      SELECT prev_success_ms, prev_consecutive_errors FROM prev
    `)) as unknown as {
      rows?: {
        prev_success_ms: string | number | null;
        prev_consecutive_errors: number | null;
      }[];
    };
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      prevSuccessMs:
        row.prev_success_ms == null ? null : Number(row.prev_success_ms),
      prevConsecutiveErrors: Number(row.prev_consecutive_errors ?? 0),
    };
  } catch (e) {
    console.error(
      `[DEVICE-STATE] success upsert systemId=${systemId} failed (swallowed): ${
        (e as Error)?.message ?? String(e)
      }`,
    );
    return null;
  }
}

/** Record a failed poll. */
async function writeDeviceStateErrorPg(
  systemId: number,
  now: Date,
  errorMessage: string,
  transformedResponse: unknown,
): Promise<void> {
  const ts = now.toISOString();
  const response = jsonbParam(transformedResponse);
  try {
    await requirePlanetscaleDb().execute(sql`
      INSERT INTO device_state (
        device_id, last_poll_time, last_error_time, last_error, last_response,
        consecutive_errors, total_polls, successful_polls, updated_at
      )
      SELECT d.id, ${ts}::timestamp, ${ts}::timestamp, ${errorMessage}, ${response}, 1, 1, 0, ${ts}::timestamp
      FROM devices d
      WHERE d.rid = ${systemId}
      ON CONFLICT (device_id) DO UPDATE SET
        last_poll_time = ${ts}::timestamp,
        last_error_time = ${ts}::timestamp,
        last_error = ${errorMessage},
        last_response = ${response},
        consecutive_errors = device_state.consecutive_errors + 1,
        total_polls = device_state.total_polls + 1,
        updated_at = ${ts}::timestamp
    `);
  } catch (e) {
    console.error(
      `[DEVICE-STATE] error upsert systemId=${systemId} failed (swallowed): ${
        (e as Error)?.message ?? String(e)
      }`,
    );
  }
}
