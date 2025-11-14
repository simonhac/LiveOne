import { createClient } from "@vercel/kv";

/**
 * Vercel KV client for caching latest point values
 *
 * Setup:
 * 1. Create KV databases in Vercel dashboard:
 *    - liveone-kv-dev (for development)
 *    - liveone-kv-prod (for production)
 * 2. Add environment variables:
 *    - KV_REST_API_URL
 *    - KV_REST_API_TOKEN
 */

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.warn(
    "KV_REST_API_URL or KV_REST_API_TOKEN not set - KV cache will not function",
  );
}

export const kv = createClient({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

/**
 * Generate a namespaced KV key
 *
 * Adds environment prefix to prevent dev/prod/test key collisions
 *
 * @param pattern - Key pattern (e.g., "latest:system:123")
 * @returns Namespaced key (e.g., "dev:latest:system:123")
 *
 * @example
 * kvKey("latest:system:123") // "dev:latest:system:123" in development
 * kvKey("username:simon")    // "prod:username:simon" in production
 */
export function kvKey(pattern: string): string {
  const namespace = process.env.KV_NAMESPACE || "dev";
  return `${namespace}:${pattern}`;
}
