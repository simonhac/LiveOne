/**
 * Snapshot the prod KV "latest values" into the dev namespace, so a Vercel PREVIEW deploy — which
 * resolves to the `dev:` KV namespace (VERCEL_ENV=preview -> getEnvironment()="dev") — shows
 * live-style power cards. This is a ONE-TIME static snapshot: the values won't update, because
 * nothing polls into the `dev` namespace.
 *
 * Env (from .env.local): KV_REST_API_URL, KV_REST_API_TOKEN — the (shared) KV store.
 *   SOURCE_KV_PREFIX  default "prod"
 *   TARGET_KV_PREFIX  default "dev"
 *
 * Usage:
 *   npx tsx scripts/seed-preview-kv.ts
 */
import { createClient } from "@vercel/kv";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const url = required("KV_REST_API_URL");
const token = required("KV_REST_API_TOKEN");
const SRC = process.env.SOURCE_KV_PREFIX ?? "prod";
const DST = process.env.TARGET_KV_PREFIX ?? "dev";

const kv = createClient({ url, token });

/** Copy a hash key from the source prefix to the target prefix (replacing any existing). */
async function copyHash(srcKey: string): Promise<boolean> {
  const dstKey = `${DST}:${srcKey.slice(SRC.length + 1)}`;
  const data = await kv.hgetall(srcKey);
  if (!data || Object.keys(data).length === 0) return false;
  await kv.del(dstKey);
  await kv.hset(dstKey, data as Record<string, unknown>);
  return true;
}

async function main() {
  // The per-system latest-value hashes (one per system) + the rollup summaries hash.
  const keys = [
    ...(await kv.keys(`${SRC}:latest:system:*`)),
    `${SRC}:system-summaries`,
  ];
  let copied = 0;
  for (const k of keys) {
    if (await copyHash(k)) {
      copied++;
      console.log(`copied ${k} -> ${DST}:${k.slice(SRC.length + 1)}`);
    }
  }
  console.log(`KV snapshot complete: ${copied} key(s) ${SRC}: -> ${DST}:`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
