/**
 * SessionId singleton for generating unique session identifiers
 *
 * Generates a random 5-character alphanumeric prefix on first use,
 * then increments a sequence number for each subsequent call.
 *
 * Format: {prefix}/{sequence}
 * Example: "aB3xZ/1", "aB3xZ/2", etc.
 *
 * The prefix persists for the lifetime of the serverless function instance
 * (up to ~15 minutes on Vercel), then resets with a new random prefix.
 */
export class SessionId {
  private static instance: SessionId | null = null;
  private prefix: string;
  private sequence: number;

  // Alphanumeric characters for prefix generation
  private static readonly CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  private constructor() {
    // Generate 5 random bytes for character selection
    const bytes = new Uint8Array(5);

    // Use crypto.getRandomValues for secure random generation
    if (
      typeof globalThis.crypto !== "undefined" &&
      globalThis.crypto.getRandomValues
    ) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      // Fallback for Node.js environments
      const crypto = require("crypto");
      const randomBytes = crypto.randomBytes(5);
      for (let i = 0; i < 5; i++) {
        bytes[i] = randomBytes[i];
      }
    }

    // Convert bytes to alphanumeric characters
    this.prefix = Array.from(bytes)
      .map((b) => SessionId.CHARS[b % SessionId.CHARS.length])
      .join("");
    this.sequence = 0; // Will be incremented to 1 on first use

    console.log(
      `[SessionId] New session initialized with prefix: ${this.prefix}`,
    );
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): SessionId {
    if (!SessionId.instance) {
      SessionId.instance = new SessionId();
    }
    return SessionId.instance;
  }

  /**
   * Get the next session ID
   * @returns Session ID in format "prefix/sequence"
   */
  getNext(): string {
    this.sequence++;
    return `${this.prefix}/${this.sequence}`;
  }

  /**
   * Get the current sequence number without incrementing
   * @returns Current sequence number
   */
  getCurrentSequence(): number {
    return this.sequence;
  }

  /**
   * Get the session prefix
   * @returns The 5-character alphanumeric prefix
   */
  getPrefix(): string {
    return this.prefix;
  }

  /**
   * Format a session ID with a sub-sequence
   * @param sessionId The base session ID (e.g., "aB3xZ/3")
   * @param subSequence The sub-sequence number
   * @returns Formatted session ID (e.g., "aB3xZ/3.1")
   */
  static formatWithSubSequence(sessionId: string, subSequence: number): string {
    return `${sessionId}.${subSequence}`;
  }

  /**
   * Clear the singleton instance (useful for testing)
   */
  static clearInstance(): void {
    SessionId.instance = null;
  }
}

// Export a convenience function for getting the next session ID
export function getNextSessionId(): string {
  return SessionId.getInstance().getNext();
}

// Export a convenience function for formatting with sub-sequence
export function formatSessionId(
  sessionId: string,
  subSequence: number,
): string {
  return SessionId.formatWithSubSequence(sessionId, subSequence);
}
