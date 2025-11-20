import { createClient } from "@vercel/kv";
import { getEnvironment } from "./env";

/**
 * Vercel KV client for caching latest point values
 *
 * Setup:
 * 1. Create KV database in Vercel dashboard (shared across all environments)
 * 2. Add environment variables:
 *    - KV_REST_API_URL
 *    - KV_REST_API_TOKEN
 *
 * Namespacing:
 * - Keys are automatically namespaced by environment (prod/dev/test)
 * - This prevents data collisions when using the same KV instance
 */

const kvConfigured = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);
let kvWarned = false;

function warnOnce() {
  if (!kvWarned) {
    console.warn(
      "KV_REST_API_URL or KV_REST_API_TOKEN not set - KV cache will not function",
    );
    kvWarned = true;
  }
}

// Create client eagerly, but use a Proxy to warn only on actual access
const kvClient = kvConfigured
  ? createClient({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    })
  : null;

export const kv = new Proxy({} as ReturnType<typeof createClient>, {
  get(_target, prop) {
    if (!kvClient) {
      warnOnce();
      // Return no-op functions instead of throwing
      return () => Promise.resolve(null);
    }
    return (kvClient as any)[prop];
  },
});

/**
 * Generate a namespaced KV key
 *
 * Automatically adds environment prefix (prod/dev/test) to prevent key collisions
 * in the shared KV store.
 *
 * @param pattern - Key pattern (e.g., "latest:system:123")
 * @returns Namespaced key (e.g., "dev:latest:system:123")
 *
 * @example
 * kvKey("latest:system:123") // "dev:latest:system:123" in development
 * kvKey("username:simon")    // "prod:username:simon" in production
 */
export function kvKey(pattern: string): string {
  const namespace = getEnvironment();
  return `${namespace}:${pattern}`;
}
