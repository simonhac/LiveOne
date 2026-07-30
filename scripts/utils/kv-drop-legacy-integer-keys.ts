/**
 * One-shot: delete the pre-config-v4-Phase-13-PR-3 INTEGER-addressed KV entries.
 *
 * PR 3 moved the keyspace to TypeIDs:
 *
 *   latest:system:{int}         →  latest:device:{dv_…} | latest:area:{ar_…}
 *   subscriptions:system:{int}  →  subscriptions:device:{dv_…}
 *   oe:sched:system:{int}       →  oe:sched:device:{dv_…}
 *   {env}:system-summaries      →  same hash, but every FIELD is now a dv_/ar_ TypeID
 *
 * KV is disposable, so nothing is migrated in place — the new keys are (re)built by the deploy step
 * (`buildSubscriptionRegistry` + the next poll / `db:rebuild-dev-kv`). But the OLD keys are not
 * overwritten either: they are simply orphaned, invisible to every new SCAN pattern, and they hold
 * stale readings forever. This sweeps them.
 *
 * It is a DELETE-ONLY script, scoped to this environment's prefix, and it refuses to touch anything
 * that is not integer-addressed. Run it ONCE per environment, AFTER the new build is live.
 *
 * 🛑 dev and prod share ONE physical Redis store, separated only by the `kvKey()` prefix. This script
 * therefore prints the resolved environment and every key it is about to delete, and requires
 * `--yes` to actually delete. Run it dry first, read the list, then re-run with `--yes`.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/utils/kv-drop-legacy-integer-keys.ts          # dry run
 *   npx tsx --env-file=.env.local scripts/utils/kv-drop-legacy-integer-keys.ts --yes    # delete
 *
 * Delete this script once both environments are swept — git is the archive.
 */
import { kv, kvKey } from "@/lib/kv";
import { getEnvironment } from "@/lib/env";
import { summariesKey } from "@/lib/kv-keys";

/** The three retired key families, as patterns within the current environment prefix. */
const LEGACY_PATTERNS = [
  "latest:system:*",
  "subscriptions:system:*",
  "oe:sched:system:*",
];

/** A retired summaries FIELD is a bare integer; a current one is a `dv_`/`ar_` TypeID. */
const INTEGER_FIELD = /^\d+$/;

async function scanAll(pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match: pattern, count: 200 });
    cursor = Number(next);
    out.push(...keys);
  } while (cursor !== 0);
  return out.sort();
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--yes");
  const env = getEnvironment();

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("✗ KV_REST_API_URL / KV_REST_API_TOKEN not set. Aborting.");
    process.exit(1);
  }

  console.log(`Resolved environment: ${env}  (key prefix "${env}:")`);
  console.log(
    `  VERCEL_ENV=${process.env.VERCEL_ENV ?? "<unset>"} NODE_ENV=${process.env.NODE_ENV ?? "<unset>"}`,
  );
  console.log(`  first pattern: ${kvKey(LEGACY_PATTERNS[0])}`);
  console.log(`  mode: ${apply ? "DELETE" : "dry run (pass --yes to delete)"}`);

  const doomedKeys: string[] = [];
  for (const pattern of LEGACY_PATTERNS) {
    const keys = await scanAll(kvKey(pattern));
    console.log(`\n${kvKey(pattern)} → ${keys.length} legacy key(s)`);
    for (const k of keys) console.log(`  ${k}`);
    doomedKeys.push(...keys);
  }

  const sKey = summariesKey();
  const summaries = ((await kv.hgetall(sKey)) ?? {}) as Record<string, unknown>;
  const doomedFields = Object.keys(summaries).filter((f) =>
    INTEGER_FIELD.test(f),
  );
  console.log(
    `\n${sKey} → ${doomedFields.length} integer field(s) of ${Object.keys(summaries).length}`,
  );
  console.log(`  ${JSON.stringify(doomedFields.sort())}`);

  if (!apply) {
    console.log(
      `\nDry run — nothing deleted. Re-run with --yes to delete ${doomedKeys.length} key(s) and ${doomedFields.length} field(s).`,
    );
    return;
  }

  if (doomedKeys.length > 0) await kv.del(...doomedKeys);
  if (doomedFields.length > 0) await kv.hdel(sKey, ...doomedFields);
  console.log(
    `\n✓ Deleted ${doomedKeys.length} legacy key(s) and ${doomedFields.length} legacy summaries field(s) from the "${env}:" namespace.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ kv-drop-legacy-integer-keys failed:", err);
    process.exit(1);
  });
