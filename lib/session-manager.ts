import { db } from '@/lib/db';
import { sessions, systems, type NewSession } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export type SessionCause = 'POLL' | 'ADMIN' | 'USER' | 'PUSH';

export interface SessionData {
  sessionLabel?: string | null;
  systemId: number;
  vendorType: string;
  systemName: string;
  cause: SessionCause;
  started: Date;
  duration: number; // milliseconds
  successful: boolean;
  errorCode?: string | null;
  error?: string | null;
  response?: any | null; // Will be stored as JSON
  numRows: number;
}

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
   * Record a communication session with an energy system
   */
  async recordSession(data: SessionData): Promise<void> {
    try {
      const sessionRecord: NewSession = {
        sessionLabel: data.sessionLabel || null,
        systemId: data.systemId,
        vendorType: data.vendorType,
        systemName: data.systemName,
        cause: data.cause,
        started: data.started,
        duration: data.duration,
        successful: data.successful,
        errorCode: data.errorCode || null,
        error: data.error || null,
        response: data.response || null,
        numRows: data.numRows,
      };

      await db.insert(sessions).values(sessionRecord);
    } catch (error) {
      // Log the error but don't throw - we don't want session recording to break the main flow
      console.error('[SessionManager] Failed to record session:', error);
    }
  }

  /**
   * Helper method to record a session with timing
   */
  async recordTimedSession(
    sessionData: Omit<SessionData, 'started' | 'duration'>,
    operation: () => Promise<{ successful: boolean; errorCode?: string; error?: string; response?: any; numRows?: number }>
  ): Promise<void> {
    const started = new Date();
    let result;

    try {
      result = await operation();
    } catch (error) {
      result = {
        successful: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        numRows: 0
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
  async getSystemInfo(systemId: number): Promise<{ vendorType: string; systemName: string } | null> {
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
      console.error('[SessionManager] Failed to get system info:', error);
      return null;
    }
  }

  /**
   * Get sessions starting from a specific ID (for pagination)
   */
  async getSessions(start: number, count: number): Promise<{
    sessions: Array<{
      id: number;
      sessionLabel: string | null;
      systemId: number;
      vendorType: string;
      systemName: string;
      cause: string;
      started: Date;
      duration: number;
      successful: boolean;
      errorCode: string | null;
      error: string | null;
      response: any | null;
      numRows: number;
      createdAt: Date;
    }>;
    count: number;
  }> {
    try {
      const { gte, desc } = await import('drizzle-orm');

      const limit = Math.min(count, 100); // Cap at 100

      const results = await db
        .select()
        .from(sessions)
        .where(gte(sessions.id, start))
        .orderBy(desc(sessions.id))
        .limit(limit);

      return {
        sessions: results,
        count: results.length,
      };
    } catch (error) {
      console.error('[SessionManager] Failed to fetch sessions:', error);
      return {
        sessions: [],
        count: 0,
      };
    }
  }

  /**
   * Get the last N sessions (most recent)
   */
  async getLastSessions(count: number): Promise<{
    sessions: Array<{
      id: number;
      sessionLabel: string | null;
      systemId: number;
      vendorType: string;
      systemName: string;
      cause: string;
      started: Date;
      duration: number;
      successful: boolean;
      errorCode: string | null;
      error: string | null;
      response: any | null;
      numRows: number;
      createdAt: Date;
    }>;
    count: number;
  }> {
    try {
      const { desc } = await import('drizzle-orm');

      const limit = Math.min(count, 100); // Cap at 100

      const results = await db
        .select()
        .from(sessions)
        .orderBy(desc(sessions.id))
        .limit(limit);

      return {
        sessions: results,
        count: results.length,
      };
    } catch (error) {
      console.error('[SessionManager] Failed to fetch last sessions:', error);
      return {
        sessions: [],
        count: 0,
      };
    }
  }
}

// Export singleton instance
export const sessionManager = SessionManager.getInstance();