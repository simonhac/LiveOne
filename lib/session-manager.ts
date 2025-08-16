/**
 * Simple in-memory session management for MVP
 * In production, this would use Redis or a database
 */

interface Session {
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  loginTime: Date;
  lastActivity: Date;
  isActive: boolean;
}

class SessionManager {
  private static instance: SessionManager;
  private sessions: Map<string, Session> = new Map();
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  private constructor() {}

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  createSession(email: string, displayName: string, role: 'user' | 'admin'): string {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36)}`;
    
    this.sessions.set(sessionId, {
      email,
      displayName,
      role,
      loginTime: new Date(),
      lastActivity: new Date(),
      isActive: true,
    });

    // Clean up old sessions
    this.cleanupSessions();

    return sessionId;
  }

  getSession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    
    if (!session) return null;
    
    // Check if session is expired
    const now = Date.now();
    const lastActivity = session.lastActivity.getTime();
    
    if (now - lastActivity > this.SESSION_TIMEOUT) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    // Update last activity
    session.lastActivity = new Date();
    
    return session;
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
    }
    this.sessions.delete(sessionId);
  }

  getActiveSessions(): Array<Session & { sessionId: string }> {
    const active: Array<Session & { sessionId: string }> = [];
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isActive) {
        active.push({ ...session, sessionId });
      }
    }
    
    return active;
  }

  getUserSessions(email: string): Array<Session & { sessionId: string }> {
    const userSessions: Array<Session & { sessionId: string }> = [];
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.email === email) {
        userSessions.push({ ...session, sessionId });
      }
    }
    
    return userSessions;
  }

  private cleanupSessions(): void {
    const now = Date.now();
    
    for (const [sessionId, session] of this.sessions.entries()) {
      const lastActivity = session.lastActivity.getTime();
      
      if (now - lastActivity > this.SESSION_TIMEOUT) {
        this.sessions.delete(sessionId);
      }
    }
  }

  // Get summary for admin dashboard
  getSessionSummary(): Map<string, {
    email: string;
    displayName: string;
    lastLogin: Date | null;
    isLoggedIn: boolean;
    activeSessions: number;
  }> {
    const summary = new Map<string, any>();
    
    for (const session of this.sessions.values()) {
      if (!summary.has(session.email)) {
        summary.set(session.email, {
          email: session.email,
          displayName: session.displayName,
          lastLogin: session.loginTime,
          isLoggedIn: session.isActive,
          activeSessions: 0,
        });
      }
      
      const userSummary = summary.get(session.email);
      if (session.isActive) {
        userSummary.activeSessions++;
        userSummary.isLoggedIn = true;
      }
      
      // Update last login to most recent
      if (!userSummary.lastLogin || session.loginTime > userSummary.lastLogin) {
        userSummary.lastLogin = session.loginTime;
      }
    }
    
    return summary;
  }
}

export default SessionManager;