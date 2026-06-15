#!/usr/bin/env tsx
/**
 * P3 parity gate: prove the typed `area_bindings` / `flow_1d.area_id` re-key reproduces the legacy
 * `systems.metadata` / `system_id` behaviour EXACTLY, against the LIVE backfilled DB. Run this in the
 * env you just backfilled (dev first, then prod) BEFORE flipping `AREAS_TABLE` on there — it is the
 * Track-A verification gate in docs/architecture/areas-and-dashboards.md (P3).
 *
 * Read-only (SELECT only — never writes). The DB target is whatever `.env.local` points at via
 * `requirePlanetscaleDb()` (`PLANETSCALE_DATABASE_URL`). Exits non-zero on any mismatch.
 *
 * Checks (anchored on the real composites #7 Craig, #8 Kinkora + a sample of identity systems):
 *   A. Binding parity — the backfilled `area_bindings` point-set for each composite EQUALS what the
 *      tested converter derives from that composite's CURRENT `systems.metadata` (no point gained/lost,
 *      metric_type matches). This is the convert.test.ts gate, re-run against live rows not fixtures.
 *   B. flow_1d area-keyed — every `point_readings_flow_1d` row has a non-null `area_id` (the legacy
 *      `system_id` column was dropped in migration 0013, so `area_id` is now the sole view key).
 *
 * Usage:  npx tsx scripts/verify-areas-parity.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { sql, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "../lib/db/planetscale";
import {
  areas,
  systems,
  pointInfo,
  areaBindings,
} from "../lib/db/planetscale/schema";
import {
  convertCompositeToBindings,
  type ConverterPointInfo,
} from "../lib/areas/convert";

type Db = ReturnType<typeof requirePlanetscaleDb>;

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Order-insensitive key for a binding point edge. */
const edgeKey = (b: {
  role: string;
  metricType: string;
  pointSystemId: number;
  pointId: number;
}) => `${b.role}|${b.metricType}|${b.pointSystemId}.${b.pointId}`;

async function loadPoints(db: Db): Promise<ConverterPointInfo[]> {
  return db
    .select({
      systemId: pointInfo.systemId,
      pointIndex: pointInfo.index,
      logicalPathStem: pointInfo.logicalPathStem,
      metricType: pointInfo.metricType,
      transform: pointInfo.transform,
    })
    .from(pointInfo);
}

/** A. Backfilled bindings == converter(current metadata) for every composite. */
async function checkBindingParity(db: Db) {
  console.log("A. Binding parity (live area_bindings vs converter(metadata))");
  const composites = await db
    .select()
    .from(systems)
    .where(eq(systems.vendorType, "composite"));
  const points = await loadPoints(db);

  for (const c of composites) {
    const expected = convertCompositeToBindings(c.metadata, points);
    const expectedSet = new Set(expected.map(edgeKey));

    const live = await db
      .select({
        role: areaBindings.role,
        metricType: areaBindings.metricType,
        pointSystemId: areaBindings.pointSystemId,
        pointId: areaBindings.pointId,
      })
      .from(areaBindings)
      .innerJoin(areas, eq(areaBindings.areaId, areas.id))
      .where(eq(areas.legacySystemId, c.id));
    const liveSet = new Set(live.map(edgeKey));

    const missing = [...expectedSet].filter((k) => !liveSet.has(k));
    const extra = [...liveSet].filter((k) => !expectedSet.has(k));
    check(
      missing.length === 0 && extra.length === 0,
      `${c.displayName} (#${c.id}): ${live.length} live bindings`,
      missing.length || extra.length
        ? `missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`
        : "point-set matches converter",
    );
  }
}

/** B. Every flow_1d row is Area-keyed (the `system_id` column was dropped in migration 0013). */
async function checkFlowAreaKeyed(db: Db) {
  console.log("\nB. flow_1d area-keyed smoke check (no NULL area_id)");
  const res = await db.execute(sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE area_id IS NULL) AS null_area
    FROM point_readings_flow_1d
  `);
  const row = res.rows[0] as { total: number; null_area: number };
  const nullArea = Number(row.null_area);
  check(
    nullArea === 0,
    `${Number(row.total)} flow rows`,
    nullArea === 0 ? "all area-keyed" : `${nullArea} rows with NULL area_id`,
  );
}

async function main() {
  const db = requirePlanetscaleDb();
  console.log("P3 Areas parity verification (read-only)\n");
  await checkBindingParity(db);
  await checkFlowAreaKeyed(db);
  console.log(
    `\n${failures === 0 ? "✓ PASS" : `✗ FAIL (${failures} mismatch${failures === 1 ? "" : "es"})`} — parity ${failures === 0 ? "proven" : "NOT proven; do not flip AREAS_TABLE"}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ verify-areas-parity failed:", err);
  process.exit(1);
});
