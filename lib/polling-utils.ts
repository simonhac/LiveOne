import { db } from "@/lib/db/turso";
import { pollingStatus } from "@/lib/db/turso/schema";
import { eq } from "drizzle-orm";
import { transformForStorage } from "@/lib/json";
import {
  shadowReadConfig,
  toEpochSeconds,
  normalizeJson,
  SHADOW_SKIP,
} from "@/lib/db/config-shadow";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pollingStatus as pgPollingStatus } from "@/lib/db/planetscale/schema";

/**
 * Get the last polling status for a system.
 *
 * PR-8: shadow-reads polling_status from Postgres when CONFIG_READS_FROM_PG is on (the
 * served value is still Turso; PG divergence is logged only). See lib/db/config-shadow.ts.
 */
export async function getPollingStatus(systemId: number) {
  return shadowReadConfig(
    "getPollingStatus",
    async () => {
      const [status] = await db
        .select()
        .from(pollingStatus)
        .where(eq(pollingStatus.systemId, systemId))
        .limit(1);
      return status || null;
    },
    {
      diffKey: String(systemId),
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        const [status] = await planetscaleDb
          .select()
          .from(pgPollingStatus)
          .where(eq(pgPollingStatus.systemId, systemId))
          .limit(1);
        return status ?? null;
      },
      normalize: normalizePollingStatusForShadow,
    },
  );
}

/**
 * Project a polling_status row to the fields compared in shadow-diff, normalizing the
 * Turso↔PG schema divergences: second-precision timestamps (Turso integer mode:"timestamp"
 * vs PG microsecond timestamp) and text-json vs jsonb.
 */
function normalizePollingStatusForShadow(row: unknown): unknown {
  if (!row) return null;
  const s = row as Record<string, any>;
  return {
    systemId: s.systemId,
    lastPollTime: toEpochSeconds(s.lastPollTime),
    lastSuccessTime: toEpochSeconds(s.lastSuccessTime),
    lastErrorTime: toEpochSeconds(s.lastErrorTime),
    lastError: s.lastError ?? null,
    lastResponse: normalizeJson(s.lastResponse),
    consecutiveErrors: s.consecutiveErrors,
    totalPolls: s.totalPolls,
    successfulPolls: s.successfulPolls,
    updatedAt: toEpochSeconds(s.updatedAt),
  };
}

/**
 * Update polling status after a successful poll
 */
export async function updatePollingStatusSuccess(
  systemId: number,
  responseData?: any,
) {
  const now = new Date();
  const existingStatus = await getPollingStatus(systemId);

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
  //
  // This ensures the database stores clean, serialized data that can be displayed
  // directly without rendering issues.
  //
  // WARNING: If you modify this to skip transformation, be prepared for:
  // - Weird object representations in JSON viewer (e.g., {calendar: {identifier: "gregory"}})
  // - Date serialization issues
  const transformedResponse = responseData
    ? transformForStorage(responseData)
    : null;

  await db
    .insert(pollingStatus)
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
      target: pollingStatus.systemId,
      set: {
        lastPollTime: now,
        lastSuccessTime: now,
        lastError: null,
        lastResponse: transformedResponse,
        consecutiveErrors: 0,
        totalPolls: existingStatus ? (existingStatus.totalPolls || 0) + 1 : 1,
        successfulPolls: existingStatus
          ? (existingStatus.successfulPolls || 0) + 1
          : 1,
        updatedAt: now,
      },
    });
}

/**
 * Update polling status after an error
 */
export async function updatePollingStatusError(
  systemId: number,
  error: Error | string,
  responseData?: any,
) {
  const now = new Date();
  const existingStatus = await getPollingStatus(systemId);
  const errorMessage = error instanceof Error ? error.message : error;

  // Transform response data if provided (same as success case)
  const transformedResponse = responseData
    ? transformForStorage(responseData)
    : null;

  await db
    .insert(pollingStatus)
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
      target: pollingStatus.systemId,
      set: {
        lastPollTime: now,
        lastErrorTime: now,
        lastError: errorMessage,
        lastResponse: transformedResponse,
        consecutiveErrors: existingStatus
          ? (existingStatus.consecutiveErrors || 0) + 1
          : 1,
        totalPolls: existingStatus ? (existingStatus.totalPolls || 0) + 1 : 1,
        updatedAt: now,
      },
    });
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
