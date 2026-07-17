/**
 * Environment detection utilities
 */

export type Environment = "prod" | "dev" | "test";

/**
 * Get the current environment
 *
 * Detection logic:
 * - Test: NODE_ENV === "test"
 * - Production: VERCEL_ENV === "production"
 * - Development: Everything else (local development)
 *
 * @returns The current environment: "prod", "dev", or "test"
 */
export function getEnvironment(): Environment {
  // Test environment (for running tests)
  if (process.env.NODE_ENV === "test") {
    return "test";
  }

  // Production environment (Vercel sets VERCEL_ENV)
  if (process.env.VERCEL_ENV === "production") {
    return "prod";
  }

  // Development environment (local, preview deployments, etc.)
  return "dev";
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return getEnvironment() === "prod";
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return getEnvironment() === "dev";
}

/**
 * Check if running in test mode
 */
export function isTest(): boolean {
  return getEnvironment() === "test";
}

/**
 * Environment label for outbound alert/webhook messages.
 *
 * POLICY (2026-07-16): the OBSERVATIONS_ALERT_WEBHOOK_URL Slack webhook is shared
 * between dev and prod, so EVERY message sent to it must self-identify its
 * environment. Any new webhook sender must prefix its text with `[${envLabel()}]`.
 *
 * Finer-grained than getEnvironment(): preserves Vercel's production/preview/
 * development distinction where available.
 */
export function envLabel(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
}
