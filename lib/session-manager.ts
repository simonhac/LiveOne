import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { transformForStorage } from "@/lib/json";
import type { SessionInfo } from "@/lib/point/point-manager";
import { buildSessionPayload } from "@/lib/observations/session-publisher";
import { publishPoll } from "@/lib/observations/poll-collector";
import type { RawObservationInput } from "@/lib/observations/publisher";
import { SystemsManager } from "@/lib/systems-manager";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  sessions as pgSessions,
  systems as pgSystems,
} from "@/lib/db/planetscale/schema";

export type SessionCause =
  | "CRON"
  | "ADMIN"
  | "USER"
  | "PUSH"
  | "USER-TEST"
  | "ADMIN-DRYRUN";

/**
 * Input data for creating/recording a session
 */
export interface SessionData {
  sessionLabel?: string | null;
  systemId: number;
  cause: SessionCause;
  started: Date;
  duration: number; // milliseconds
  successful: boolean;
  errorCode?: string | null;
  error?: string | null;
  response?: any | null; // Will be stored as JSON
  numRows: number;
}

/**
 * Full session record with system info (from JOIN with systems table)
 * Used by: getSessions, getLastSessions, getSessionsByLabel, getSessionById
 *
 * Session reads are served from Postgres. `id` is the app-minted UUIDv7 (text);
 * historical ids are stringified integers. Postgres has no `started` column;
 * its `createdAt` holds the legacy store's `started` value, so `started`/`createdAt`
 * are both mapped from PG `createdAt`.
 */
export interface SessionWithSystem {
  id: string;
  sessionLabel: string | null;
  systemId: number;
  vendorType: string; // from systems.vendorType
  systemName: string; // from systems.displayName
  cause: string;
  started: Date;
  duration: number;
  successful: boolean | null; // null = pending/in-progress
  errorCode: string | null;
  error: string | null;
  response: any | null;
  numRows: number;
  createdAt: Date;
}

/**
 * Session summary without response field (for list views)
 * Used by: querySessions
 */
export type SessionSummary = Omit<SessionWithSystem, "response">;

/**
 * In-process registry of pending sessions. `createSession` stashes the session's
 * descriptive fields here so `updateSessionResult` can assemble the combined
 * session+observations publish message at close WITHOUT a database read-back
 * (the legacy backing store was decommissioned in Phase 5). create + update
 * always run in the same invocation, so a Map is sufficient.
 */
interface PendingSession {
  systemId: number;
  cause: SessionCause;
  started: Date;
  sessionLabel: string | null;
}
const pendingSessions = new Map<string, PendingSession>();

export class SessionManager {
  private static instance: SessionManager | null = null;

  private constructor() {}

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Create a new session record and return SessionInfo.
   *
   * The session id is an app-minted UUIDv7 (text, time-ordered) — this removes
   * the dependency on the legacy store's autoincrement (decision E). The
   * authoritative copy is written to Postgres via the queue.
   * Note: vendorType and systemName are no longer stored - they're retrieved via JOIN with systems table
   */
  async createSession(data: {
    sessionLabel?: string | null;
    systemId: number;
    cause: SessionCause;
    started: Date;
  }): Promise<SessionInfo> {
    try {
      // Use sessionLabel if provided, otherwise fallback to last 4 chars of VERCEL_DEPLOYMENT_ID
      let sessionLabel = data.sessionLabel;
      if (!sessionLabel && process.env.VERCEL_DEPLOYMENT_ID) {
        // Take last 4 characters of deployment ID
        const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
        sessionLabel = deploymentId.slice(-4);
      }
      sessionLabel = sessionLabel || null;

      const id = uuidv7();

      // Stash the pending session in-process; updateSessionResult reads it back
      // to build the combined publish message at close (no DB write here — the
      // session lands in Postgres via the queue at session close).
      pendingSessions.set(id, {
        systemId: data.systemId,
        cause: data.cause,
        started: data.started,
        sessionLabel,
      });

      return { id, started: data.started, label: sessionLabel };
    } catch (error) {
      // Log the error but don't throw - we don't want session recording to break the main flow
      console.error("[SessionManager] Failed to create session:", error);
      throw error; // Re-throw so caller knows session creation failed
    }
  }

  /**
   * Update session with final results
   */
  async updateSessionResult(
    sessionId: string,
    data: {
      duration: number;
      successful: boolean;
      errorCode?: string | null;
      error?: string | null;
      response?: any | null;
      numRows: number;
    },
    pollObservations: RawObservationInput[],
  ): Promise<void> {
    try {
      // ⚠️  CRITICAL: Transform response data before storage
      //
      // The response may contain objects like CalendarDate, Date, or fields ending in *TimeMs
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
      const transformedResponse = data.response
        ? transformForStorage(data.response)
        : null;

      const pending = pendingSessions.get(sessionId);
      if (!pending) {
        console.warn(
          `[SessionManager] No pending session ${sessionId} in-process — cannot publish result (skipped).`,
        );
        return;
      }

      const sessionPublishInput = {
        id: sessionId,
        sessionLabel: pending.sessionLabel,
        systemId: pending.systemId,
        cause: pending.cause,
        started: pending.started,
        duration: data.duration,
        successful: data.successful,
        errorCode: data.errorCode || null,
        error: data.error || null,
        response: transformedResponse,
        numRows: data.numRows,
        // Postgres has no separate `started` column; createdAt carries it.
        createdAt: pending.started,
      };

      // Emit a single combined message (session + all readings) to the queue,
      // which the receiver materialises into Postgres. The session is included
      // even when there are zero readings.
      const system = await SystemsManager.getInstance().getSystem(
        pending.systemId,
      );
      if (system) {
        await publishPoll(
          system,
          buildSessionPayload(sessionPublishInput, system.timezoneOffsetMin),
          pollObservations,
        );
      }
      pendingSessions.delete(sessionId);
    } catch (error) {
      // Log the error but don't throw - we don't want session recording to break the main flow
      console.error("[SessionManager] Failed to update session:", error);
    }
  }

  /**
   * Record a communication session with an energy system
   * @deprecated Use createSession() and updateSessionResult() instead
   */
  async recordSession(data: SessionData): Promise<void> {
    try {
      // Use sessionLabel if provided, otherwise fallback to last 4 chars of VERCEL_DEPLOYMENT_ID
      let sessionLabel = data.sessionLabel;
      if (!sessionLabel && process.env.VERCEL_DEPLOYMENT_ID) {
        // Take last 4 characters of deployment ID
        const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
        sessionLabel = deploymentId.slice(-4);
      }
      sessionLabel = sessionLabel || null;

      // ⚠️  CRITICAL: Transform response data before storage
      // See updateSessionResult() for detailed explanation of why this is necessary
      const transformedResponse = data.response
        ? transformForStorage(data.response)
        : null;

      const sessionPublishInput = {
        id: uuidv7(),
        sessionLabel,
        systemId: data.systemId,
        cause: data.cause,
        started: data.started,
        duration: data.duration,
        successful: data.successful,
        errorCode: data.errorCode || null,
        error: data.error || null,
        response: transformedResponse,
        numRows: data.numRows,
        // Postgres has no separate `started` column; createdAt carries it.
        createdAt: data.started,
      };

      // Publish the completed session to the queue (→ Postgres via the receiver);
      // a session-only message with no readings.
      const system = await SystemsManager.getInstance().getSystem(
        data.systemId,
      );
      if (system) {
        await publishPoll(
          system,
          buildSessionPayload(sessionPublishInput, system.timezoneOffsetMin),
          [],
        );
      }
    } catch (error) {
      // Log the error but don't throw - we don't want session recording to break the main flow
      console.error("[SessionManager] Failed to record session:", error);
    }
  }

  /**
   * Helper method to record a session with timing
   */
  async recordTimedSession(
    sessionData: Omit<SessionData, "started" | "duration">,
    operation: () => Promise<{
      successful: boolean;
      errorCode?: string;
      error?: string;
      response?: any;
      numRows?: number;
    }>,
  ): Promise<void> {
    const started = new Date();
    let result;

    try {
      result = await operation();
    } catch (error) {
      result = {
        successful: false,
        error: error instanceof Error ? error.message : "Unknown error",
        numRows: 0,
      };
    }

    const duration = Date.now() - started.getTime();

    await this.recordSession({
      ...sessionData,
      started,
      duration,
      successful: result.successful,
      errorCode: result.errorCode,
      error: result.error,
      response: result.response,
      numRows: result.numRows || 0,
    });
  }

  /**
   * Get system info for session recording
   */
  async getSystemInfo(
    systemId: number,
  ): Promise<{ vendorType: string; systemName: string } | null> {
    try {
      const system = await SystemsManager.getInstance().getSystem(systemId);
      if (!system) {
        return null;
      }

      return {
        vendorType: system.vendorType,
        systemName: system.displayName || `System ${systemId}`,
      };
    } catch (error) {
      console.error("[SessionManager] Failed to get system info:", error);
      return null;
    }
  }

  /**
   * Map a joined Postgres (sessions ⋈ systems) row to SessionWithSystem.
   * Postgres has no `started` column — `createdAt` holds the legacy store's
   * `started` value, so both `started` and `createdAt` are derived from it.
   */
  private mapPgRow(r: {
    sessions: typeof pgSessions.$inferSelect;
    systems: typeof pgSystems.$inferSelect;
  }): SessionWithSystem {
    return {
      id: r.sessions.id,
      sessionLabel: r.sessions.sessionLabel,
      systemId: r.sessions.systemId,
      vendorType: r.systems.vendorType,
      systemName: r.systems.displayName,
      cause: r.sessions.cause,
      started: r.sessions.createdAt,
      duration: r.sessions.duration,
      successful: r.sessions.successful,
      errorCode: r.sessions.errorCode,
      error: r.sessions.error,
      response: r.sessions.response,
      numRows: r.sessions.numRows,
      createdAt: r.sessions.createdAt,
    };
  }

  /**
   * Get the most recent `count` sessions, optionally older than `before`
   * (keyset pagination by createdAt — replaces the old numeric-id cursor, which
   * is invalid now that ids are UUIDv7 text). Served from Postgres.
   */
  async getSessions(
    _start: number,
    count: number,
    before?: Date,
  ): Promise<{ sessions: SessionWithSystem[]; count: number }> {
    if (!planetscaleDb) return { sessions: [], count: 0 };
    try {
      const { lt, desc } = await import("drizzle-orm");
      const limit = Math.min(count, 100); // Cap at 100

      const results = await planetscaleDb
        .select()
        .from(pgSessions)
        .innerJoin(pgSystems, eq(pgSessions.systemId, pgSystems.id))
        .where(before ? lt(pgSessions.createdAt, before) : undefined)
        .orderBy(desc(pgSessions.createdAt))
        .limit(limit);

      const mappedResults = results.map((r) => this.mapPgRow(r));
      return { sessions: mappedResults, count: mappedResults.length };
    } catch (error) {
      console.error("[SessionManager] Failed to fetch sessions:", error);
      return { sessions: [], count: 0 };
    }
  }

  /**
   * Get the last N sessions (most recent). Served from Postgres.
   */
  async getLastSessions(
    count: number,
  ): Promise<{ sessions: SessionWithSystem[]; count: number }> {
    if (!planetscaleDb) return { sessions: [], count: 0 };
    try {
      const { desc } = await import("drizzle-orm");
      const limit = Math.min(count, 200); // Cap at 200

      const results = await planetscaleDb
        .select()
        .from(pgSessions)
        .innerJoin(pgSystems, eq(pgSessions.systemId, pgSystems.id))
        .orderBy(desc(pgSessions.createdAt))
        .limit(limit);

      const mappedResults = results.map((r) => this.mapPgRow(r));
      return { sessions: mappedResults, count: mappedResults.length };
    } catch (error) {
      console.error("[SessionManager] Failed to fetch last sessions:", error);
      return { sessions: [], count: 0 };
    }
  }

  /**
   * Get sessions by label. Served from Postgres.
   */
  async getSessionsByLabel(
    label: string,
  ): Promise<{ sessions: SessionWithSystem[]; count: number }> {
    if (!planetscaleDb) return { sessions: [], count: 0 };
    try {
      const { desc } = await import("drizzle-orm");
      const results = await planetscaleDb
        .select()
        .from(pgSessions)
        .innerJoin(pgSystems, eq(pgSessions.systemId, pgSystems.id))
        .where(eq(pgSessions.sessionLabel, label))
        .orderBy(desc(pgSessions.createdAt))
        .limit(100); // Cap at 100 results per label

      const mappedResults = results.map((r) => this.mapPgRow(r));
      return { sessions: mappedResults, count: mappedResults.length };
    } catch (error) {
      console.error(
        "[SessionManager] Failed to fetch sessions by label:",
        error,
      );
      return { sessions: [], count: 0 };
    }
  }

  /**
   * Get a single session by ID. Served from Postgres.
   */
  async getSessionById(sessionId: string): Promise<SessionWithSystem | null> {
    if (!planetscaleDb) return null;
    try {
      const results = await planetscaleDb
        .select()
        .from(pgSessions)
        .innerJoin(pgSystems, eq(pgSessions.systemId, pgSystems.id))
        .where(eq(pgSessions.id, sessionId))
        .limit(1);

      if (results.length === 0) return null;
      return this.mapPgRow(results[0]);
    } catch (error) {
      console.error("[SessionManager] Failed to fetch session:", error);
      return null;
    }
  }

  /**
   * Query sessions with server-side filtering, sorting, and pagination.
   * Served from Postgres.
   */
  async querySessions(params: {
    // Filters
    systemNames?: string[];
    vendorTypes?: string[];
    causes?: string[];
    successful?: (boolean | null)[]; // null = pending/in-progress
    timeRangeHours?: number; // e.g., 24, 72, 168, 720 for 24h, 3d, 7d, 30d

    // Sorting
    sortBy?:
      | "started"
      | "duration"
      | "systemName"
      | "vendorType"
      | "cause"
      | "numRows";
    sortOrder?: "asc" | "desc";

    // Pagination
    page?: number; // 0-indexed
    pageSize?: number; // default 100

    // Total count (for pagination UI)
    includeTotalCount?: boolean;
  }): Promise<{
    sessions: SessionSummary[];
    totalCount?: number;
    page: number;
    pageSize: number;
  }> {
    const page = params.page ?? 0;
    const pageSize = Math.min(params.pageSize ?? 100, 100); // Cap at 100
    if (!planetscaleDb) {
      return { sessions: [], page, pageSize };
    }
    try {
      const { and, or, inArray, gte, lt, isNull, desc, asc } = await import(
        "drizzle-orm"
      );

      // Build WHERE conditions
      const conditions = [];

      if (params.systemNames && params.systemNames.length > 0) {
        conditions.push(inArray(pgSystems.displayName, params.systemNames));
      }

      if (params.vendorTypes && params.vendorTypes.length > 0) {
        conditions.push(inArray(pgSystems.vendorType, params.vendorTypes));
      }

      if (params.causes && params.causes.length > 0) {
        conditions.push(inArray(pgSessions.cause, params.causes));
      }

      if (params.successful && params.successful.length > 0) {
        const successConditions = params.successful.map((s) =>
          s === null
            ? isNull(pgSessions.successful)
            : eq(pgSessions.successful, s),
        );
        conditions.push(or(...successConditions)!);
      }

      if (params.timeRangeHours) {
        const cutoffTime = new Date(
          Date.now() - params.timeRangeHours * 60 * 60 * 1000,
        );
        conditions.push(gte(pgSessions.createdAt, cutoffTime));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Determine sort column and direction (PG createdAt stands in for `started`)
      let orderByClause;
      const sortOrder = params.sortOrder === "asc" ? asc : desc;
      switch (params.sortBy) {
        case "duration":
          orderByClause = sortOrder(pgSessions.duration);
          break;
        case "systemName":
          orderByClause = sortOrder(pgSystems.displayName);
          break;
        case "vendorType":
          orderByClause = sortOrder(pgSystems.vendorType);
          break;
        case "cause":
          orderByClause = sortOrder(pgSessions.cause);
          break;
        case "numRows":
          orderByClause = sortOrder(pgSessions.numRows);
          break;
        case "started":
        default:
          orderByClause = sortOrder(pgSessions.createdAt);
          break;
      }

      const offset = page * pageSize;

      // Count query is skipped for performance - "go to last" unavailable
      const totalCount: number | undefined = undefined;
      void lt; // reserved for future keyset pagination

      const results = await planetscaleDb
        .select()
        .from(pgSessions)
        .innerJoin(pgSystems, eq(pgSessions.systemId, pgSystems.id))
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(pageSize)
        .offset(offset);

      // Map joined results to flat structure, excluding response field for performance
      const sessionsWithoutResponse = results.map((r) => ({
        id: r.sessions.id,
        sessionLabel: r.sessions.sessionLabel,
        systemId: r.sessions.systemId,
        vendorType: r.systems.vendorType,
        systemName: r.systems.displayName,
        cause: r.sessions.cause,
        started: r.sessions.createdAt,
        duration: r.sessions.duration,
        successful: r.sessions.successful,
        errorCode: r.sessions.errorCode,
        error: r.sessions.error,
        numRows: r.sessions.numRows,
        createdAt: r.sessions.createdAt,
      }));

      return {
        sessions: sessionsWithoutResponse,
        totalCount,
        page,
        pageSize,
      };
    } catch (error) {
      console.error("[SessionManager] Failed to query sessions:", error);
      return {
        sessions: [],
        page,
        pageSize,
      };
    }
  }
}

// Export singleton instance
export const sessionManager = SessionManager.getInstance();
