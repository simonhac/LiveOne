#!/usr/bin/env tsx
/**
 * P6 data migration — retire the legacy per-system dashboard rows + the `users.default_system_id`
 * pointer so migration 0022 can drop `dashboards.system_id`/`area_id` and `users.default_system_id`.
 * (`areas.source_system_id` needs no data step — membership already lives in `area_devices`.)
 *
 * Runs AFTER the P6 code deploys (schema.ts no longer defines these columns) and BEFORE 0022 drops
 * them, so it addresses the columns via RAW SQL, not drizzle refs. It MUST make every
 * `dashboards.system_id` NULL or 0022's guard aborts.
 *
 * Per `dashboards` row with `system_id NOT NULL`:
 *   - DELETE  it if it is a genuine legacy row (`display_name IS NULL`) with 0 share tokens + 0 grants
 *             (prod #1 Daylesford Selectronic, #3 Amber Kinkora — the device view + area dashboards
 *             already cover them);
 *   - CONVERT in place otherwise (UPDATE by id: null `system_id` + `area_id`, backfill a `display_name`)
 *             — never delete+reinsert (dashboard_share_tokens/dashboard_grants FK-cascade on delete).
 * Then null every `users.default_system_id` (device-as-default retired; `default_dashboard_id` is the
 * sole landing pointer now).
 *
 * Idempotent (re-run = empty plan), backup-first, dry-run by default.
 *
 * Usage (prod — see docs/plans/capability-cleanup-rollout.md):
 *   PLANETSCALE_DATABASE_URL="$PROD_URL" ALLOW_PROD_DB_IN_DEV=true \
 *     npx tsx --env-file=.env.local scripts/cleanup/p6-legacy-dashboards.ts           # dry-run
 *   PLANETSCALE_DATABASE_URL="$PROD_URL" ALLOW_PROD_DB_IN_DEV=true \
 *     npx tsx --env-file=.env.local scripts/cleanup/p6-legacy-dashboards.ts --apply
 */
import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";

const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log(...a);

interface LegacyRow {
  id: number;
  display_name: string | null;
  system_id: number;
  area_id: string | null;
  token_count: number;
  grant_count: number;
}

async function main() {
  const db = requirePlanetscaleDb();

  // Legacy per-system dashboard rows + their share-token / grant counts.
  const legacy = (
    await db.execute(sql`
      SELECT d.id, d.display_name, d.system_id, d.area_id,
             (SELECT count(*) FROM dashboard_share_tokens t WHERE t.dashboard_id = d.id)::int AS token_count,
             (SELECT count(*) FROM dashboard_grants g WHERE g.dashboard_id = d.id)::int AS grant_count
      FROM dashboards d
      WHERE d.system_id IS NOT NULL
      ORDER BY d.id
    `)
  ).rows as unknown as LegacyRow[];

  const defaultUsers = (
    await db.execute(sql`
      SELECT clerk_user_id, default_system_id, default_dashboard_id
      FROM users WHERE default_system_id IS NOT NULL
    `)
  ).rows as unknown as Array<{
    clerk_user_id: string;
    default_system_id: number;
    default_dashboard_id: number | null;
  }>;

  const toDelete = legacy.filter(
    (d) =>
      d.display_name == null &&
      Number(d.token_count) === 0 &&
      Number(d.grant_count) === 0,
  );
  const toConvert = legacy.filter((d) => !toDelete.includes(d));

  // Backup every affected row (the inverse).
  const backupDir = path.join(process.cwd(), "scripts", "cleanup", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(backupDir, `p6-legacy-dashboards-${stamp}.json`),
    JSON.stringify({ takenAt: stamp, legacy, defaultUsers }, null, 2),
  );

  log("\nPLAN:");
  log(
    `  delete ${toDelete.length} vestigial legacy dashboard(s): [${toDelete.map((d) => d.id).join(", ")}]`,
  );
  log(
    `  convert ${toConvert.length} legacy dashboard(s) in place: [${toConvert.map((d) => d.id).join(", ")}]`,
  );
  log(`  null default_system_id for ${defaultUsers.length} user(s)`);

  if (!APPLY) {
    log("\n(dry-run — pass --apply to execute)");
    return;
  }

  await db.transaction(async (tx) => {
    for (const d of toDelete) {
      await tx.execute(sql`DELETE FROM dashboards WHERE id = ${d.id}`);
    }
    for (const d of toConvert) {
      await tx.execute(sql`
        UPDATE dashboards
        SET system_id = NULL,
            area_id = NULL,
            display_name = COALESCE(display_name, ${`Dashboard ${d.id}`}),
            updated_at = now()
        WHERE id = ${d.id}
      `);
    }
    // Device-as-default retired: null every legacy pointer (default_dashboard_id is authoritative).
    await tx.execute(
      sql`UPDATE users SET default_system_id = NULL, updated_at = now() WHERE default_system_id IS NOT NULL`,
    );
  });

  log(
    "\n✅ applied. dashboards.system_id is now all-NULL → migration 0022 can run.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
