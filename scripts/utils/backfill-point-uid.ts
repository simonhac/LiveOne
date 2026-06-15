#!/usr/bin/env tsx
/**
 * Backfill point_info.point_uid (Part 1 — identity/address split).
 *
 * Idempotent: only fills rows where point_uid IS NULL. Deterministic uuidv5 over
 * (vendor_type, vendor_site_id, physical_path_tail) — the SAME derivation ensurePointInfo uses, so
 * existing and future rows agree. Duplicate-site collisions (same derived uid) get a random uid
 * (uuidv7) instead, and are logged.
 *
 * Writes ONLY point_uid. Targets whatever .env.local points at (dev by default). To run against prod,
 * point the connection at the sydney branch deliberately.
 *
 * Run: npx tsx --env-file=.env.local scripts/utils/backfill-point-uid.ts [--commit]
 *   (dry-run by default; pass --commit to write)
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

async function main() {
  const commit = process.argv.includes("--commit");
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { pointInfo, systems } = await import("@/lib/db/planetscale/schema");
  const { derivePointUid } = await import("@/lib/identifiers/point-uid");

  if (!planetscaleDb) throw new Error("Postgres not configured");

  // Rows still needing a uid, joined to their system's vendor identity.
  const rows = await planetscaleDb
    .select({
      systemId: pointInfo.systemId,
      index: pointInfo.index,
      physicalPathTail: pointInfo.physicalPathTail,
      vendorType: systems.vendorType,
      vendorSiteId: systems.vendorSiteId,
    })
    .from(pointInfo)
    .innerJoin(systems, eq(systems.id, pointInfo.systemId))
    .where(isNull(pointInfo.pointUid));

  // Existing non-null uids (so the backfill's collision check spans the whole table, not just this batch).
  const existing = await planetscaleDb
    .select({ pointUid: pointInfo.pointUid })
    .from(pointInfo)
    .where(sql`${pointInfo.pointUid} IS NOT NULL`);
  const seen = new Set<string>(existing.map((r) => r.pointUid as string));

  let deterministic = 0;
  let randomFallback = 0;
  const updates: Array<{ systemId: number; index: number; uid: string }> = [];

  for (const r of rows) {
    let uid = derivePointUid(r.vendorType, r.vendorSiteId, r.physicalPathTail);
    if (seen.has(uid)) {
      const collidedWith = uid;
      uid = uuidv7();
      randomFallback++;
      console.warn(
        `  ⚠ collision for system ${r.systemId} "${r.physicalPathTail}" (derived ${collidedWith}) — random uid ${uid}`,
      );
    } else {
      deterministic++;
    }
    seen.add(uid);
    updates.push({ systemId: r.systemId, index: r.index, uid });
  }

  console.log(
    `point_uid backfill: ${rows.length} null rows → ${deterministic} deterministic + ${randomFallback} random fallback`,
  );

  if (!commit) {
    console.log("DRY RUN — pass --commit to write. Sample:");
    for (const u of updates.slice(0, 5))
      console.log(`  (${u.systemId}, ${u.index}) → ${u.uid}`);
    process.exit(0);
  }

  for (const u of updates) {
    await planetscaleDb
      .update(pointInfo)
      .set({ pointUid: u.uid })
      .where(
        and(eq(pointInfo.systemId, u.systemId), eq(pointInfo.index, u.index)),
      );
  }
  console.log(`✅ wrote ${updates.length} point_uid values`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
