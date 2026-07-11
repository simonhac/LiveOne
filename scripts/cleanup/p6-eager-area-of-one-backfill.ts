#!/usr/bin/env tsx
/**
 * P6 / SP-1 — Backfill an area-of-one for every system that lacks one (the one-time counterpart to the
 * eager `createSystem` hook). Uses the same `ensureAreaOfOne` primitive as the hook + the daily heal, so
 * it is idempotent and race-safe (located by `areas_legacy_system_unique`) and always heals the single
 * `area_devices` member. Dry-run by default.
 *
 * PROD (sydney) is the durable target — liveone-dev mirrors prod on the 2h sync, so a dev run only
 * persists for systems prod does not have. An area-of-one's mere existence does NOT force flow
 * computation (the isCompleteRoleSet gate is untouched), so this has no flow_1d side effect.
 *
 * Usage:
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/cleanup/p6-eager-area-of-one-backfill.ts          # dry-run
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/cleanup/p6-eager-area-of-one-backfill.ts --apply
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems, areas } from "@/lib/db/planetscale/schema";
import { ensureAreaOfOne } from "@/lib/areas/sync";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = requirePlanetscaleDb();

  const allSystems = await db
    .select({
      id: systems.id,
      ownerClerkUserId: systems.ownerClerkUserId,
      displayName: systems.displayName,
      timezoneOffsetMin: systems.timezoneOffsetMin,
      displayTimezone: systems.displayTimezone,
      status: systems.status,
      vendorType: systems.vendorType,
    })
    .from(systems);
  const areaHandles = new Set(
    (await db.select({ h: areas.legacySystemId }).from(areas))
      .map((r) => r.h)
      .filter((h): h is number => h != null),
  );

  const missing = allSystems.filter((s) => !areaHandles.has(s.id));
  if (missing.length === 0) {
    console.log(
      "Every system already has an area-of-one — nothing to backfill.",
    );
    return;
  }

  console.log(`Systems missing an area-of-one (${missing.length}):`);
  for (const s of missing)
    console.log(`  ${s.id}  ${s.vendorType}  "${s.displayName}"`);

  if (!APPLY) {
    console.log("\n(dry-run — pass --apply to mint them)");
    return;
  }

  for (const s of missing) {
    const areaId = await ensureAreaOfOne(s);
    console.log(`  ✓ system ${s.id} → area ${areaId}`);
  }
  console.log(`\n✅ backfilled ${missing.length} area-of-one row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
