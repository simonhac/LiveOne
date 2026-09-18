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

/**
 * Per-command tally, for answering "how many Redis commands does this code path cost?".
 *
 * Upstash bills PER COMMAND, and `@vercel/kv` enables auto-pipelining by default — which merges
 * commands issued in the same microtask into ONE HTTP request but bills them individually. So HTTP
 * request counts, network traces and the Upstash latency graph all understate the cost, and this
 * Proxy is the only place every command provably passes through.
 *
 * Off by default (an unconditional Map write on the hot path would be its own small tax); armed by
 * {@link startKvCommandCount}. Counting is process-local and not concurrency-safe — it is a
 * measurement tool for a test or a single hand-run request, not telemetry.
 */
let kvCommandCounts: Map<string, number> | null = null;

/** Begin (or restart) counting commands by name. */
export function startKvCommandCount(): void {
  kvCommandCounts = new Map();
}

/** Stop counting and return the tally. Returns an empty result if counting was never started. */
export function stopKvCommandCount(): {
  total: number;
  byCommand: Record<string, number>;
} {
  const counts = kvCommandCounts ?? new Map<string, number>();
  kvCommandCounts = null;
  let total = 0;
  for (const n of counts.values()) total += n;
  return { total, byCommand: Object.fromEntries(counts) };
}

export const kv = new Proxy({} as ReturnType<typeof createClient>, {
  get(_target, prop) {
    const client = getKvClient();
    if (!client) {
      warnOnce();
      // Return no-op functions instead of throwing
      return () => Promise.resolve(null);
    }
    const value = (client as any)[prop];
    // Wrap only while armed, so the default path is byte-for-byte what it was before.
    if (kvCommandCounts && typeof value === "function") {
      const name = String(prop);
      return (...args: unknown[]) => {
        // Re-read the Map each call: a wrapper captured before `stopKvCommandCount` must not keep
        // writing into a tally the caller has already taken.
        kvCommandCounts?.set(name, (kvCommandCounts.get(name) ?? 0) + 1);
        return value.apply(client, args);
      };
    }
    return value;
  },
});

/**
 * Generate a namespaced KV key
 *
 * Automatically adds environment prefix (prod/dev/test) to prevent key collisions
 * in the shared KV store.
 *
 * @param pattern - Key pattern (e.g., "latest:device:dv_01k9…")
 * @returns Namespaced key (e.g., "dev:latest:device:dv_01k9…")
 *
 * @example
 * kvKey("latest:device:dv_01k9…") // "dev:latest:device:dv_01k9…" in development
 * kvKey("username:simon")    // "prod:username:simon" in production
 */
export function kvKey(pattern: string): string {
  const namespace = getEnvironment();
  return `${namespace}:${pattern}`;
}
