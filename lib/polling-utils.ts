import { eq, sql } from "drizzle-orm";
import { transformForStorage } from "@/lib/json";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pollingStatus as pgPollingStatus } from "@/lib/db/planetscale/schema";

/**
 * Get the last polling status for a system (from Postgres).
 */
export async function getPollingStatus(systemId: number) {
  const [status] = await requirePlanetscaleDb()
    .select()
    .from(pgPollingStatus)
    .where(eq(pgPollingStatus.systemId, systemId))
    .limit(1);
  return status ?? null;
}

/**
 * Update polling status after a successful poll.
 */
export async function updatePollingStatusSuccess(
  systemId: number,
  responseData?: any,
) {
  const now = new Date();

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

  // The counter increment is ATOMIC in the upsert — `total_polls + 1` etc. are
  // computed from the existing row inside onConflictDoUpdate (no read-then-write),
  // so concurrent polls can't lose increments.
  await writePollingStatusSuccessPg(systemId, now, transformedResponse);
}

/**
 * Postgres success upsert.
 *
 * LOG-BUT-DON'T-THROW: a PG write failure here is caught and logged, never rethrown.
 * This function is called from the poll's `shouldPoll` path; if it threw, the caller
 * would treat the poll as failed and re-poll, minting a duplicate session.
 *
 * ATOMIC counters: on conflict we reference the EXISTING row
 * (`polling_status.total_polls + 1`, `polling_status.successful_polls + 1`) via `sql`,
 * so the increment happens server-side in a single statement with no read-then-write race.
 * `consecutive_errors` resets to 0 on success.
 */
async function writePollingStatusSuccessPg(
  systemId: number,
  now: Date,
  transformedResponse: unknown,
): Promise<void> {
  try {
    await requirePlanetscaleDb()
      .insert(pgPollingStatus)
      .values({
        systemId,
        lastPollTime: now,
        lastSuccessTime: now,
        lastError: null,
        lastResponse: transformedResponse,
        consecutiveErrors: 0,
        totalPolls: 1,
        successfulPolls: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgPollingStatus.systemId,
        set: {
          lastPollTime: now,
          lastSuccessTime: now,
          lastError: null,
          lastResponse: transformedResponse,
          consecutiveErrors: 0,
          totalPolls: sql`${pgPollingStatus.totalPolls} + 1`,
          successfulPolls: sql`${pgPollingStatus.successfulPolls} + 1`,
          updatedAt: now,
        },
      });
  } catch (e) {
    console.error(
      `[POLLING-STATUS] updatePollingStatusSuccess systemId=${systemId} failed (swallowed): ${
        (e as Error)?.message ?? String(e)
      }`,
    );
  }
}

/**
 * Update polling status after an error.
 */
export async function updatePollingStatusError(
  systemId: number,
  error: Error | string,
  responseData?: any,
) {
  const now = new Date();
  const errorMessage = error instanceof Error ? error.message : error;

  // Transform response data if provided (same as success case)
  const transformedResponse = responseData
    ? transformForStorage(responseData)
    : null;

  // `consecutive_errors` and `total_polls` increment atomically in the upsert.
  await writePollingStatusErrorPg(
    systemId,
    now,
    errorMessage,
    transformedResponse,
  );
}

/**
 * Postgres error upsert.
 *
 * LOG-BUT-DON'T-THROW (see writePollingStatusSuccessPg): a PG failure is caught and
 * logged, never rethrown, so a poll-error path can't itself throw and re-poll.
 *
 * ATOMIC counters: on conflict, `consecutive_errors` and `total_polls` are incremented
 * from the EXISTING row via `sql` in a single statement. `successful_polls` is left
 * untouched on conflict.
 */
async function writePollingStatusErrorPg(
  systemId: number,
  now: Date,
  errorMessage: string,
  transformedResponse: unknown,
): Promise<void> {
  try {
    await requirePlanetscaleDb()
      .insert(pgPollingStatus)
      .values({
        systemId,
        lastPollTime: now,
        lastErrorTime: now,
        lastError: errorMessage,
        lastResponse: transformedResponse,
        consecutiveErrors: 1,
        totalPolls: 1,
        successfulPolls: 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgPollingStatus.systemId,
        set: {
          lastPollTime: now,
          lastErrorTime: now,
          lastError: errorMessage,
          lastResponse: transformedResponse,
          consecutiveErrors: sql`${pgPollingStatus.consecutiveErrors} + 1`,
          totalPolls: sql`${pgPollingStatus.totalPolls} + 1`,
          updatedAt: now,
        },
      });
  } catch (e) {
    console.error(
      `[POLLING-STATUS] updatePollingStatusError systemId=${systemId} failed (swallowed): ${
        (e as Error)?.message ?? String(e)
      }`,
    );
  }
}

/**
 * Common polling result interface
 */
export interface PollingResult {
  systemId: number;
  displayName?: string;
  vendorType?: string;
  status: "polled" | "skipped" | "error";
  recordsUpserted?: number;
  skipReason?: string;
  error?: string;
  durationMs?: number;
  lastPoll?: string | null; // When the last successful poll occurred (AEST formatted)
  nextPollTimeMs?: number; // When the next poll is scheduled (Unix timestamp in milliseconds)
  rawResponse?: any; // Raw vendor response for debugging
  data?: any; // Optional vendor-specific data
}

/**
 * Validate a system for polling
 * Returns a PollingResult with error if validation fails, or null if valid
 */
export function validateSystemForPolling(
  system: any,
  expectedVendorType?: string,
): PollingResult | null {
  // Check if system exists
  if (!system) {
    return {
      systemId: 0,
      status: "error",
      error: "System not found",
    };
  }

  // Check vendor type if specified
  if (expectedVendorType && system.vendorType !== expectedVendorType) {
    return {
      systemId: system.id,
      displayName: system.displayName || undefined,
      vendorType: system.vendorType,
      status: "error",
      error: `Not a ${expectedVendorType} system (type: ${system.vendorType})`,
    };
  }

  // Check if owner is configured
  if (!system.ownerClerkUserId) {
    return {
      systemId: system.id,
      displayName: system.displayName || undefined,
      vendorType: system.vendorType,
      status: "error",
      error: "No owner configured",
    };
  }

  // Validation passed
  return null;
}
