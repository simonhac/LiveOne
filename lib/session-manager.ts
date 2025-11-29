import { db } from "@/lib/db";
import { sessions, systems, type NewSession } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { transformForStorage } from "@/lib/json";
import type { SessionInfo } from "@/lib/point/point-manager";
import { publishSession } from "@/lib/observations/session-publisher";

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
 */
export interface SessionWithSystem {
  id: number;
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
   * Create a new session record and return SessionInfo
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

      const sessionRecord: NewSession = {
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

      const result = await db
        .insert(sessions)
        .values(sessionRecord)
        .returning();

      return { id: result[0].id, started: data.started };
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
    sessionId: number,
    data: {
      duration: number;
      successful: boolean;
      errorCode?: string | null;
      error?: string | null;
      response?: any | null;
      numRows: number;
    },
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
        await publishSession({
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
        });
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
   * Get sessions starting from a specific ID (for pagination)
   */
  async getSessions(
    start: number,
    count: number,
  ): Promise<{ sessions: SessionWithSystem[]; count: number }> {
    try {
      const { gte, desc } = await import("drizzle-orm");

      const limit = Math.min(count, 100); // Cap at 100

      const results = await db
        .select()
        .from(sessions)
        .innerJoin(systems, eq(sessions.systemId, systems.id))
        .where(gte(sessions.id, start))
        .orderBy(desc(sessions.id))
        .limit(limit);

      // Map joined results to flat structure with vendorType and systemName from systems
      const mappedResults = results.map((r) => ({
        ...r.sessions,
        vendorType: r.systems.vendorType,
        systemName: r.systems.displayName,
      }));

      return {
        sessions: mappedResults,
        count: mappedResults.length,
      };
    } catch (error) {
      console.error("[SessionManager] Failed to fetch sessions:", error);
      return {
        sessions: [],
        count: 0,
      };
    }
  }

  /**
   * Get the last N sessions (most recent)
   */
  async getLastSessions(
    count: number,
  ): Promise<{ sessions: SessionWithSystem[]; count: number }> {
    try {
      const { desc } = await import("drizzle-orm");

      const limit = Math.min(count, 100); // Cap at 100

      const results = await db
        .select()
        .from(sessions)
        .innerJoin(systems, eq(sessions.systemId, systems.id))
        .orderBy(desc(sessions.id))
        .limit(limit);

      // Map joined results to flat structure
      const mappedResults = results.map((r) => ({
        ...r.sessions,
        vendorType: r.systems.vendorType,
        systemName: r.systems.displayName,
      }));

      return {
        sessions: mappedResults,
        count: mappedResults.length,
      };
    } catch (error) {
      console.error("[SessionManager] Failed to fetch last sessions:", error);
      return {
        sessions: [],
        count: 0,
      };
    }
  }

  /**
   * Get sessions by label
   */
  async getSessionsByLabel(
    label: string,
  ): Promise<{ sessions: SessionWithSystem[]; count: number }> {
    try {
      const results = await db
        .select()
        .from(sessions)
        .innerJoin(systems, eq(sessions.systemId, systems.id))
        .where(eq(sessions.sessionLabel, label))
        .limit(100); // Cap at 100 results per label

      // Map joined results to flat structure
      const mappedResults = results.map((r) => ({
        ...r.sessions,
        vendorType: r.systems.vendorType,
        systemName: r.systems.displayName,
      }));

      return {
        sessions: mappedResults,
        count: mappedResults.length,
      };
    } catch (error) {
      console.error(
        "[SessionManager] Failed to fetch sessions by label:",
        error,
      );
      return {
        sessions: [],
        count: 0,
      };
    }
  }

  /**
   * Get a single session by ID
   */
  async getSessionById(sessionId: number): Promise<SessionWithSystem | null> {
    try {
      const results = await db
        .select()
        .from(sessions)
        .innerJoin(systems, eq(sessions.systemId, systems.id))
        .where(eq(sessions.id, sessionId))
        .limit(1);

      if (results.length === 0) return null;

      // Map joined result to flat structure
      const r = results[0];
      return {
        ...r.sessions,
        vendorType: r.systems.vendorType,
        systemName: r.systems.displayName,
      };
    } catch (error) {
      console.error("[SessionManager] Failed to fetch session:", error);
      return null;
    }
  }

  /**
   * Query sessions with server-side filtering, sorting, and pagination
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
    try {
      const { and, or, inArray, gte, desc, asc, sql, count } = await import(
        "drizzle-orm"
      );

      // Build WHERE conditions
      const conditions = [];

      if (params.systemIds && params.systemIds.length > 0) {
        conditions.push(inArray(sessions.systemId, params.systemIds));
      }

      if (params.vendorTypes && params.vendorTypes.length > 0) {
        // Filter on systems.vendorType (joined table)
        conditions.push(inArray(systems.vendorType, params.vendorTypes));
      }

      if (params.causes && params.causes.length > 0) {
        conditions.push(inArray(sessions.cause, params.causes));
      }

      if (params.successful && params.successful.length > 0) {
        // Handle boolean/null array - convert to OR conditions
        // null = pending (in-progress), true = success, false = failed
        const { isNull } = await import("drizzle-orm");
        const successConditions = params.successful.map((s) =>
          s === null ? isNull(sessions.successful) : eq(sessions.successful, s),
        );
        conditions.push(or(...successConditions)!);
      }

      if (params.timeRangeHours) {
        const cutoffTime = new Date(
          Date.now() - params.timeRangeHours * 60 * 60 * 1000,
        );
        conditions.push(gte(sessions.started, cutoffTime));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Determine sort column and direction
      let orderByClause;
      const sortOrder = params.sortOrder === "asc" ? asc : desc;

      switch (params.sortBy) {
        case "duration":
          orderByClause = sortOrder(sessions.duration);
          break;
        case "systemName":
          // Sort by systems.displayName (joined table)
          orderByClause = sortOrder(systems.displayName);
          break;
        case "vendorType":
          // Sort by systems.vendorType (joined table)
          orderByClause = sortOrder(systems.vendorType);
          break;
        case "cause":
          orderByClause = sortOrder(sessions.cause);
          break;
        case "numRows":
          orderByClause = sortOrder(sessions.numRows);
          break;
        case "started":
        default:
          orderByClause = sortOrder(sessions.started);
          break;
      }

      // Pagination
      const page = params.page ?? 0;
      const pageSize = Math.min(params.pageSize ?? 100, 100); // Cap at 100
      const offset = page * pageSize;

      // Count query is skipped for performance - "go to last" unavailable
      const totalCount: number | undefined = undefined;

      // Execute main query with JOIN to systems table
      // Response field will be excluded in the mapping below for performance
      const results = await db
        .select()
        .from(sessions)
        .innerJoin(systems, eq(sessions.systemId, systems.id))
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
        started: r.sessions.started,
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
        page: params.page ?? 0,
        pageSize: params.pageSize ?? 100,
      };
    }
  }
}

// Export singleton instance
export const sessionManager = SessionManager.getInstance();
