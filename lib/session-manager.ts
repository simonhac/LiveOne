import { db } from "@/lib/db/turso";
import { sessions, systems, type NewSession } from "@/lib/db/turso/schema";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { transformForStorage } from "@/lib/json";
import type { SessionInfo } from "@/lib/point/point-manager";
import {
  publishSession,
  buildSessionPayload,
} from "@/lib/observations/session-publisher";
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
 * Session reads are served from Postgres (the full history mirror) — see the
 * Postgres-primary migration (PR-7a). `id` is the app-minted UUIDv7 (text);
 * historical ids are stringified integers. Postgres has no `started` column;
 * its `createdAt` holds the Turso `started` value, so `started`/`createdAt` are
 * both mapped from PG `createdAt`.
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
   * the dependency on Turso's autoincrement (decision E). The pending session is
   * still written to Turso as a best-effort backup; the authoritative copy is
   * mirrored to Postgres via the queue.
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

      const sessionRecord: NewSession = {
        id,
        sessionLabel,
        systemId: data.systemId,
        cause: data.cause,
        started: data.started,
        duration: 0, // Will be updated when session completes
        // successful left as NULL (pending) - will be updated when session completes
        errorCode: null,
        error: null,
        response: null,
        numRows: 0,
      };

      await db.insert(sessions).values(sessionRecord);

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
    pollObservations?: RawObservationInput[],
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

      await db
        .update(sessions)
        .set({
          duration: data.duration,
          successful: data.successful,
          errorCode: data.errorCode || null,
          error: data.error || null,
          response: transformedResponse,
          numRows: data.numRows,
        })
        .where(eq(sessions.id, sessionId));

      // Publish to QStash queue for replication
      // Fetch the full session to get all fields including started, sessionLabel, createdAt
      const session = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      if (session.length > 0) {
        const s = session[0];
        const sessionPublishInput = {
          id: s.id,
          sessionLabel: s.sessionLabel,
          systemId: s.systemId,
          cause: s.cause,
          started: s.started,
          duration: s.duration,
          successful: s.successful,
          errorCode: s.errorCode,
          error: s.error,
          response: s.response,
          numRows: s.numRows,
          createdAt: s.createdAt,
        };

        if (pollObservations !== undefined) {
          // Poll path: emit a single combined message (session + all readings).
          // The session is included even when there are zero readings.
          const system = await SystemsManager.getInstance().getSystem(
            s.systemId,
          );
          if (system) {
            await publishPoll(
              system,
              buildSessionPayload(
                sessionPublishInput,
                system.timezoneOffsetMin,
              ),
              pollObservations,
            );
          }
        } else {
          // Legacy callers: session-only publish (unchanged behavior).
          await publishSession(sessionPublishInput);
        }
      }
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

      const sessionRecord: NewSession = {
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
      };

      await db.insert(sessions).values(sessionRecord);
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
      const system = await db
        .select()
        .from(systems)
        .where(eq(systems.id, systemId))
        .limit(1);

      if (system.length === 0) {
        return null;
      }

      return {
        vendorType: system[0].vendorType,
        systemName: system[0].displayName || `System ${systemId}`,
      };
    } catch (error) {
      console.error("[SessionManager] Failed to get system info:", error);
      return null;
    }
  }

  /**
   * Map a joined Postgres (sessions ⋈ systems) row to SessionWithSystem.
   * Postgres has no `started` column — `createdAt` holds the Turso `started`
   * value, so both `started` and `createdAt` are derived from it.
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
    systemIds?: number[];
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

      if (params.systemIds && params.systemIds.length > 0) {
        conditions.push(inArray(pgSessions.systemId, params.systemIds));
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
