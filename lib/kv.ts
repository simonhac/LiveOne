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
