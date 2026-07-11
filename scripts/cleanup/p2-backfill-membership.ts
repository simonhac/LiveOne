#!/usr/bin/env tsx
/**
 * P2 — Backfill area_devices membership so it is the single authoritative source.
 *
 * All membership READS already go through getAreaDeviceSystemIds (the point resolver, the capability
 * layer, the admin list), but a few areas predate area_devices and have 0 rows — for those the reads
 * either fall back to the handle (serving is unaffected: an area-of-one's real systems row wins the
 * resolver) or show 0 members in admin. This makes the data match: for every active area with no
 * area_devices rows, derive members = source_system_id ∪ DISTINCT area_bindings.point_system_id and
 * insert them (ordinal by discovery order). Areas with no derivable members (a truly empty orphan) are
 * left untouched. Idempotent (skips areas that already have rows); backs up affected rows first.
 *
 * Usage (dev):
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/cleanup/p2-backfill-membership.ts          # dry-run
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/cleanup/p2-backfill-membership.ts --apply
 */
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areas, areaDevices, areaBindings } from "@/lib/db/planetscale/schema";

const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log(...a);

/** Ordered, de-duplicated members for an area: source first, then its distinct binding systems. */
async function deriveMembers(
  db: ReturnType<typeof requirePlanetscaleDb>,
  areaId: string,
  sourceSystemId: number | null,
): Promise<number[]> {
  const bindings = await db
    .select({ sid: areaBindings.pointSystemId, ord: areaBindings.ordinal })
    .from(areaBindings)
    .where(eq(areaBindings.areaId, areaId))
    .orderBy(areaBindings.ordinal);
  const ordered: number[] = [];
  const seen = new Set<number>();
  const push = (sid: number) => {
    if (!seen.has(sid)) {
      seen.add(sid);
      ordered.push(sid);
    }
  };
  if (sourceSystemId != null) push(sourceSystemId);
  for (const b of bindings) push(b.sid);
  return ordered;
}

async function main() {
  const db = requirePlanetscaleDb();

  // Active areas with zero area_devices rows.
  const active = await db
    .select({
      id: areas.id,
      handle: areas.legacySystemId,
      displayName: areas.displayName,
      sourceSystemId: areas.sourceSystemId,
    })
    .from(areas)
    .where(eq(areas.status, "active"));

  const plan: {
    id: string;
    handle: number | null;
    name: string;
    members: number[];
  }[] = [];
  for (const a of active) {
    const existing = await db
      .select({ sid: areaDevices.systemId })
      .from(areaDevices)
      .where(eq(areaDevices.areaId, a.id))
      .limit(1);
    if (existing.length > 0) continue; // already has membership
    const members = await deriveMembers(db, a.id, a.sourceSystemId);
    if (members.length === 0) {
      log(
        `  skip ${a.handle} "${a.displayName}" — no derivable members (empty orphan)`,
      );
      continue;
    }
    plan.push({ id: a.id, handle: a.handle, name: a.displayName, members });
  }

  if (plan.length === 0) {
    log(
      "Nothing to backfill — every active area with derivable members already has area_devices.",
    );
    return;
  }

  log("\nPLAN (backfill area_devices):");
  for (const p of plan)
    log(`  ${p.handle} "${p.name}" → members [${p.members.join(", ")}]`);

  // Backup the areas we'll touch (the inverse: delete these area_devices).
  const backupDir = path.join(process.cwd(), "scripts", "cleanup", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(backupDir, `p2-${stamp}.json`),
    JSON.stringify({ takenAt: stamp, backfilled: plan }, null, 2),
  );

  if (!APPLY) {
    log("\n(dry-run — pass --apply to execute)");
    return;
  }

  await db.transaction(async (tx) => {
    for (const p of plan) {
      await tx
        .insert(areaDevices)
        .values(
          p.members.map((sid, i) => ({
            areaId: p.id,
            systemId: sid,
            ordinal: i,
          })),
        )
        .onConflictDoNothing();
    }
  });
  log(`\n✅ backfilled ${plan.length} area(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
