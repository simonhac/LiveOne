#!/usr/bin/env tsx
/**
 * P3 backfill: seed the Areas tables from the current systems/composite metadata.
 *
 *   1. roles            — upsert the 5 rows from lib/roles/registry.ts (code stays SoT).
 *   2. identity Areas    — one per active non-composite system (1:1 wrapper).
 *   3. composite Areas   — one per vendor_type='composite' row, with typed area_bindings derived
 *                          from metadata via the tested converter. Each composite is round-trip
 *                          ASSERTED (binding point-set / source selection == today's behaviour)
 *                          BEFORE any write; one mismatch aborts the whole run.
 *   4. flow_1d re-key    — UPDATE point_readings_flow_1d.area_id = the area whose legacy_system_id
 *                          == system_id (a pure RE-KEY, never a recompute — identity Areas yield
 *                          byte-identical rows), with a DO/RAISE NULL check.
 *
 * Idempotent (areas located by legacy_system_id; bindings replaced; roles upserted).
 *
 * SAFETY: defaults to a DRY RUN (asserts + prints, writes nothing). Pass --apply to write.
 * The DB target is whatever .env.local points at — currently PROD Sydney — so --apply is gated.
 *
 * Usage:
 *   npx tsx scripts/migrate-composites-to-areas.ts            # dry run (assert only)
 *   npx tsx scripts/migrate-composites-to-areas.ts --apply    # write
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requirePlanetscaleDb } from "../lib/db/planetscale";
import {
  areas,
  roles as rolesTable,
  systems,
  pointInfo,
} from "../lib/db/planetscale/schema";
import { ROLE_IDS, ROLES } from "../lib/roles/registry";
import {
  convertCompositeToBindings,
  assertCompositeRoundTrip,
  type ConverterPointInfo,
} from "../lib/areas/convert";
import { ensureCompositeArea, syncCompositeBindings } from "../lib/areas/sync";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";

async function seedRoles(db: ReturnType<typeof requirePlanetscaleDb>) {
  const rows = ROLE_IDS.map((id) => {
    const r = ROLES[id];
    return {
      role: r.id,
      category: r.category,
      stem: r.stem,
      label: r.label,
      haDeviceClass: r.ha.deviceClass,
      haStateClass: r.ha.stateClass,
      haUnit: r.ha.unit,
      summaryMetric: r.summary?.metric ?? null,
      summaryAggregable: r.summary ? r.summary.aggregable : null,
    };
  });
  console.log(`${tag} roles: ${rows.length} from registry`);
  if (!APPLY) return;
  for (const row of rows) {
    await db
      .insert(rolesTable)
      .values(row)
      .onConflictDoUpdate({ target: rolesTable.role, set: row });
  }
}

async function seedIdentityAreas(db: ReturnType<typeof requirePlanetscaleDb>) {
  const allSystems = await db.select().from(systems);
  const physical = allSystems.filter((s) => s.vendorType !== "composite");
  const existing = await db
    .select({ legacySystemId: areas.legacySystemId })
    .from(areas)
    .where(eq(areas.kind, "identity"));
  const have = new Set(existing.map((e) => e.legacySystemId));
  const toCreate = physical.filter((s) => !have.has(s.id));
  console.log(
    `${tag} identity areas: ${physical.length} physical systems, ${toCreate.length} to create`,
  );
  if (!APPLY) return;
  for (const s of toCreate) {
    await db.insert(areas).values({
      id: uuidv7(),
      ownerClerkUserId: s.ownerClerkUserId,
      kind: "identity",
      sourceSystemId: s.id,
      legacySystemId: s.id,
      displayName: s.displayName,
      alias: s.alias,
      timezoneOffsetMin: s.timezoneOffsetMin,
      displayTimezone: s.displayTimezone,
      status: s.status,
    });
  }
}

async function seedCompositeAreas(db: ReturnType<typeof requirePlanetscaleDb>) {
  const composites = await db
    .select()
    .from(systems)
    .where(eq(systems.vendorType, "composite"));
  const piRows = await db
    .select({
      systemId: pointInfo.systemId,
      pointIndex: pointInfo.index,
      logicalPathStem: pointInfo.logicalPathStem,
      metricType: pointInfo.metricType,
      transform: pointInfo.transform,
    })
    .from(pointInfo);
  const points: ConverterPointInfo[] = piRows;

  console.log(`${tag} composite areas: ${composites.length} composites`);
  for (const c of composites) {
    // Assert FIRST — abort the whole run on any mismatch (no partial migration).
    const drafts = convertCompositeToBindings(c.metadata, points);
    assertCompositeRoundTrip(c.metadata, drafts);
    console.log(
      `${tag}   ✓ ${c.displayName} (#${c.id}): ${drafts.length} bindings round-trip OK`,
    );
    if (!APPLY) continue;
    await ensureCompositeArea(c, db);
    const n = await syncCompositeBindings(c.id);
    console.log(`${tag}     wrote ${n} bindings`);
  }
}

async function rekeyFlow1d(db: ReturnType<typeof requirePlanetscaleDb>) {
  console.log(
    `${tag} flow_1d re-key: area_id = area whose legacy_system_id = system_id`,
  );
  if (!APPLY) {
    const [{ count }] = (await db.execute(
      sql`SELECT count(*)::int AS count FROM point_readings_flow_1d f
          WHERE NOT EXISTS (SELECT 1 FROM areas a WHERE a.legacy_system_id = f.system_id)`,
    )) as unknown as Array<{ count: number }>;
    console.log(
      `${tag}   ${count} flow_1d rows have a system_id with no matching area (would fail the NULL check)`,
    );
    return;
  }
  await db.execute(sql`
    UPDATE point_readings_flow_1d f
    SET area_id = a.id
    FROM areas a
    WHERE a.legacy_system_id = f.system_id AND f.area_id IS NULL;
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM point_readings_flow_1d WHERE area_id IS NULL) THEN
        RAISE EXCEPTION 'flow_1d rows left without area_id — aborting (a system_id has no area)';
      END IF;
    END $$;
  `);
  console.log(`${tag}   flow_1d re-key complete, NULL check passed`);
}

async function main() {
  const db = requirePlanetscaleDb();
  console.log(`${tag} migrate-composites-to-areas starting`);
  await seedRoles(db);
  await seedIdentityAreas(db);
  await seedCompositeAreas(db);
  await rekeyFlow1d(db);
  console.log(
    `${tag} done.${APPLY ? "" : " No writes performed — re-run with --apply to migrate."}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ migrate-composites-to-areas failed:", err);
  process.exit(1);
});
