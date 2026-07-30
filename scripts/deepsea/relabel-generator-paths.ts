#!/usr/bin/env tsx
/**
 * One-off: relabel the DeepSea generator's point logical paths from `generator.*` to
 * `source.generator.*` (matching the role registry anchor `source.generator`).
 *
 * The musher manifest now emits `source.generator.*`, but existing point_info rows keep their old
 * stem (ensurePointInfo's onConflict doesn't touch logical_path_stem). This fixes them in place.
 *
 * Idempotent + safe: physical_path_tail is unchanged, and readings/aggregates are keyed by point
 * index, not path. The unique (system_id, logical_path_stem, metric_type) can't collide because no
 * `source.generator.*` rows exist yet.
 *
 * Targets whatever DB `.env.local` points at (liveone-dev by default). For prod, point it at sydney
 * with a short-TTL role connection string. Resolves the system by (deepsea, MUSHER_SITE_ID) so it
 * works on dev (id ≥ 10000) and prod (id 14) alike.
 *
 *   npx tsx --env-file=.env.local scripts/deepsea/relabel-generator-paths.ts --dry
 *   npx tsx --env-file=.env.local scripts/deepsea/relabel-generator-paths.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq, like } from "drizzle-orm";

const OLD_PREFIX = "generator.";
const NEW_PREFIX = "source.generator.";

async function main() {
  const dry = process.argv.includes("--dry");
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { devices, pointInfo, points } = await import(
    "@/lib/db/planetscale/schema"
  );

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres not configured (no PLANETSCALE_DATABASE_URL in .env.local).",
    );
    process.exit(1);
  }

  const siteId = process.env.MUSHER_SITE_ID ?? "sheephouse";

  const sys = await planetscaleDb
    .select({ id: devices.rid, displayName: devices.name })
    .from(devices)
    .where(and(eq(devices.vendor, "deepsea"), eq(devices.vendorSiteId, siteId)))
    .limit(1);
  if (sys.length === 0) {
    console.error(`❌ No deepsea/${siteId} system found in this DB.`);
    process.exit(1);
  }
  const systemId = sys[0].id;
  console.log(
    `• system ${systemId} "${sys[0].displayName}" (deepsea/${siteId})`,
  );

  const rows = await planetscaleDb
    .select({
      rid: points.rid,
      physicalPathTail: points.physicalPath,
      logicalPathStem: points.logicalPath,
    })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(devices.rid, systemId),
        like(points.logicalPath, `${OLD_PREFIX}%`),
      ),
    );

  if (rows.length === 0) {
    console.log("• nothing to relabel (no generator.* stems). Done.");
    process.exit(0);
  }

  console.log(`• ${rows.length} point(s) to relabel:`);
  for (const r of rows) {
    const next = NEW_PREFIX + r.logicalPathStem!.slice(OLD_PREFIX.length);
    console.log(
      `    [${r.rid}] ${r.physicalPathTail}: ${r.logicalPathStem} → ${next}`,
    );
  }

  if (dry) {
    console.log("\n(--dry) no changes written.");
    process.exit(0);
  }

  for (const r of rows) {
    const next = NEW_PREFIX + r.logicalPathStem!.slice(OLD_PREFIX.length);
    // `points` FIRST — it is the table readers serve since slice 1b, so a point_info-only relabel
    // (what this script used to do) would now be silently INEFFECTIVE. `point_info` follows as the
    // write-behind copy until PR 2 drops it. Both key on the rid, never on `point_info.index`.
    await planetscaleDb
      .update(points)
      .set({ logicalPath: next, updatedAt: new Date() })
      .where(eq(points.rid, r.rid));
    await planetscaleDb
      .update(pointInfo)
      .set({ logicalPathStem: next, updatedAt: new Date() })
      .where(and(eq(pointInfo.systemId, systemId), eq(pointInfo.rid, r.rid)));
  }
  console.log(`\n✓ relabelled ${rows.length} point(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
