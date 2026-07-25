#!/usr/bin/env tsx
/**
 * Retire provably-empty synthetic composite areas (`legacy_system_id >= 1_000_000`).
 *
 * Extracted from the cutover transform's stage 2i, which was UNSAFE (defect D-d): its gate tested only
 * 4 of the 8 FK children of `areas`, so any row it actually selected would raise 23503 mid-cutover — and
 * stage 2 was not transactional, so the abort would strand a half-applied transform. All three
 * rehearsals passed only because the DELETE matched nothing on those snapshots.
 *
 * This version is safe by construction:
 *   - the blocker list is DERIVED from `pg_constraint` at runtime, so a newly-added FK child cannot be
 *     forgotten (the original's hand-maintained list is exactly how 4-of-8 happened);
 *   - it also checks dashboard docs/descriptors for textual references, matching the precedent set by
 *     `scripts/cleanup/retire-implied-areas.ts`;
 *   - it is DRY-RUN by default and runs in daylight, decoupled from the cutover window;
 *   - it is a prerequisite for nothing. Skipping it entirely is a valid choice.
 *
 * Usage:
 *   npx tsx scripts/config-v4/retire-empty-composites.ts            # dry run (default)
 *   npx tsx scripts/config-v4/retire-empty-composites.ts --commit
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql } from "drizzle-orm";

/** Areas whose synthetic handles we consider; matches `lib/areas/handles.ts` AREA_HANDLE_BASE. */
const AREA_HANDLE_BASE = 1_000_000;

interface Child {
  table: string;
  column: string;
}

/** Every table with a FK referencing `areas`, straight from the catalog. */
async function fkChildren(
  exec: (q: string) => Promise<Record<string, unknown>[]>,
): Promise<Child[]> {
  const rows = await exec(`
    SELECT c.conrelid::regclass::text AS table_name,
           a.attname                  AS column_name
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'areas'::regclass
     ORDER BY 1, 2`);
  return rows.map((r) => ({
    table: String(r.table_name),
    column: String(r.column_name),
  }));
}

async function main() {
  const commit = process.argv.includes("--commit");
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const db = requirePlanetscaleDb();
  const exec = async (q: string) =>
    ((await db.execute(sql.raw(q))) as unknown as { rows: any[] }).rows;

  const children = await fkChildren(exec);
  console.log(`FK children of areas (${children.length}, from pg_constraint):`);
  for (const c of children) console.log(`  - ${c.table}.${c.column}`);

  // A candidate is empty only if NO child references it, and no dashboard mentions it.
  const notExists = children
    .map(
      (c) =>
        `AND NOT EXISTS (SELECT 1 FROM ${c.table} x WHERE x.${c.column} = a.id)`,
    )
    .join("\n        ");

  const candidates = await exec(`
    SELECT a.id::text AS id, a.legacy_system_id, a.display_name
      FROM areas a
     WHERE a.legacy_system_id >= ${AREA_HANDLE_BASE}
       ${notExists}
       AND NOT EXISTS (
         SELECT 1 FROM dashboards d
          WHERE d.descriptor::text LIKE '%' || a.id::text || '%'
             OR coalesce(d.doc::text, '') LIKE '%' || a.id::text || '%')
     ORDER BY a.legacy_system_id`);

  const blocked = await exec(`
    SELECT a.legacy_system_id, a.display_name
      FROM areas a
     WHERE a.legacy_system_id >= ${AREA_HANDLE_BASE}
       AND NOT (TRUE ${notExists})
     ORDER BY a.legacy_system_id`);

  console.log(
    `\nsynthetic composites RETAINED (still referenced): ${blocked.length}`,
  );
  for (const b of blocked)
    console.log(`  - ${b.legacy_system_id} "${b.display_name}"`);

  console.log(
    `\nsynthetic composites ELIGIBLE for retirement: ${candidates.length}`,
  );
  for (const c of candidates)
    console.log(`  - ${c.legacy_system_id} "${c.display_name}" (${c.id})`);

  if (candidates.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!commit) {
    console.log("\nDry-run only; rerun with --commit to delete.");
    return;
  }

  const ids = candidates.map((c) => `'${c.id}'::uuid`).join(",");
  await db.execute(
    sql.raw(`DELETE FROM legacy_handles WHERE area_id IN (${ids})`),
  );
  const deleted = await exec(
    `WITH del AS (DELETE FROM areas WHERE id IN (${ids}) RETURNING 1)
     SELECT count(*)::int AS n FROM del`,
  );
  console.log(
    `\nRetired ${deleted[0]?.n ?? 0} empty synthetic composite area(s).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
