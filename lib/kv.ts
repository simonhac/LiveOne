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

let kvWarned = false;

function warnOnce() {
  if (!kvWarned) {
    console.warn(
      "KV_REST_API_URL or KV_REST_API_TOKEN not set - KV cache will not function",
    );
    kvWarned = true;
  }
}

// Resolved LAZILY, on first property access — NOT at import time.
//
// `import`s are hoisted and evaluated before a module body runs, so any script that calls
// `dotenv.config()` in its body (every scripts/config-v4/* driver does) imports this module BEFORE
// .env.local is loaded. Reading the credentials at import time therefore latched `kvClient = null`
// permanently, and every kv.* call became the no-op Proxy below — while the caller's own
// `process.env.KV_REST_API_URL` check, running after dotenv, saw the vars and passed.
//
// That combination is silent and unfalsifiable: cutover-pause.ts's `clear` would no-op the `kv.del`,
// read the flag back as null, agree with the resumed queue and print "✅ LIVE" while the cutover flag
// was still set in KV and the receiver kept refusing every observation. Deferring resolution to first
// access makes the credentials the ones the caller actually has.
let kvResolved = false;
let kvClient: ReturnType<typeof createClient> | null = null;

function getKvClient(): ReturnType<typeof createClient> | null {
  if (!kvResolved) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    kvClient = url && token ? createClient({ url, token }) : null;
    kvResolved = true;
  }
  return kvClient;
}

export const kv = new Proxy({} as ReturnType<typeof createClient>, {
  get(_target, prop) {
    const client = getKvClient();
    if (!client) {
      warnOnce();
      // Return no-op functions instead of throwing
      return () => Promise.resolve(null);
    }
    return (client as any)[prop];
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
