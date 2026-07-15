#!/usr/bin/env tsx
/**
 * READ-ONLY sanity verifier: the LEGACY param points' per-day step rows (η / C / η_c / idle on each
 * battery Area's helper device) vs the NEW `battery_provenance_daily` params, per day.
 *
 * This is a GROSS-ERROR gate (unit mixups ×100/÷1000, day misalignment, sign flips), not an ulp gate:
 * the legacy rows were written by whatever code version last ran — e.g. pre-#169 learns had NO
 * recal-day exclusions, so a few-percent drift on early/recal-adjacent days is expected and benign
 * (the EWMA time constant is ~10 days). The byte-level equivalence guarantee is the SAME-CODE unit
 * suite (lib/battery-provenance/__tests__/daily-{reduce,fits}.test.ts). Days after the legacy last
 * write exist only in the table and are reported, not compared.
 *
 * Run against dev before cutover and against PROD before `scripts/delete-battery-param-points.ts`
 * (the step rows are the baseline this comparison needs — verification strictly precedes deletion).
 *
 * Usage: npx tsx scripts/verify-daily-learn-equivalence.ts [--tol=0.05]
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { planetscaleDb } from "../lib/db/planetscale";
import {
  areaDevices,
  areas,
  batteryProvenanceDaily,
  pointInfo,
  pointReadingsAgg5m,
  systems,
} from "../lib/db/planetscale/schema";
import { listBatteryProvenanceHandles } from "../lib/battery-provenance/recompute";

const tolArg = process.argv.find((a) => a.startsWith("--tol="))?.split("=")[1];
const TOL = tolArg ? Number(tolArg) : 0.05; // relative — a gross-error gate (see header)
const BATTERY_STEM = "bidi.battery";
// metricType → { table column key, legacy scale (point value = table value × scale) }
const PARAMS: Record<
  string,
  { col: "eta" | "capacityKwh" | "chargeEff" | "idleLossKwhDay"; scale: number }
> = {
  "round-trip-efficiency": { col: "eta", scale: 100 },
  "usable-capacity": { col: "capacityKwh", scale: 1 },
  "charge-efficiency": { col: "chargeEff", scale: 100 },
  "idle-loss": { col: "idleLossKwhDay", scale: 1 },
};

async function main() {
  const db = planetscaleDb;
  if (!db) throw new Error("No Postgres connection.");
  const [id]: any =
    (
      await db.execute(
        sql`select current_user as usr, current_database() as dbname`,
      )
    ).rows ?? [];
  console.log(`[DB] ${id?.usr}@${id?.dbname}  tol=${TOL} (relative)`);

  const handles = await listBatteryProvenanceHandles();
  let failures = 0;

  for (const handle of handles) {
    const [area] = await db
      .select({
        id: areas.id,
        name: areas.displayName,
        tz: areas.timezoneOffsetMin,
      })
      .from(areas)
      .where(eq(areas.legacySystemId, handle))
      .limit(1);
    if (!area) continue;
    const [helper] = await db
      .select({ id: systems.id })
      .from(systems)
      .innerJoin(areaDevices, eq(areaDevices.systemId, systems.id))
      .where(
        and(eq(areaDevices.areaId, area.id), eq(systems.vendorType, "helper")),
      )
      .limit(1);

    const tableRows = await db
      .select()
      .from(batteryProvenanceDaily)
      .where(eq(batteryProvenanceDaily.areaId, area.id))
      .orderBy(asc(batteryProvenanceDaily.day));
    console.log(
      `\nhandle ${handle} (${area.name}): tableDays=${tableRows.length} helper=${helper?.id ?? "-"}`,
    );
    if (!helper || tableRows.length === 0) continue;

    const offMs = area.tz * 60_000;
    const dayOfMs = (t: number) =>
      new Date(Math.floor((t + offMs - 1) / 86_400_000) * 86_400_000)
        .toISOString()
        .slice(0, 10);

    for (const [metric, spec] of Object.entries(PARAMS)) {
      const [point] = await db
        .select({ index: pointInfo.index })
        .from(pointInfo)
        .where(
          and(
            eq(pointInfo.systemId, helper.id),
            eq(pointInfo.logicalPathStem, BATTERY_STEM),
            eq(pointInfo.metricType, metric),
          ),
        )
        .limit(1);
      if (!point) {
        console.log(`  ${metric}: no legacy point (never learned) — skip`);
        continue;
      }
      const legacy = await db
        .select({
          t: pointReadingsAgg5m.intervalEnd,
          v: pointReadingsAgg5m.last,
        })
        .from(pointReadingsAgg5m)
        .where(
          and(
            eq(pointReadingsAgg5m.systemId, helper.id),
            eq(pointReadingsAgg5m.pointId, point.index),
          ),
        )
        .orderBy(asc(pointReadingsAgg5m.intervalEnd));
      const legacyByDay = new Map<string, number>();
      for (const r of legacy)
        if (r.v !== null) legacyByDay.set(dayOfMs(r.t.getTime()), r.v);

      let compared = 0;
      let maxRel = 0;
      let worst: string | null = null;
      let missing = 0;
      for (const row of tableRows) {
        const lv = legacyByDay.get(row.day);
        const tvRaw = row[spec.col];
        if (lv === undefined) continue; // beyond legacy last-write (or legacy hole) — table-only
        if (tvRaw === null) {
          missing++;
          continue;
        }
        const tv = tvRaw * spec.scale;
        const rel = Math.abs(tv - lv) / Math.max(Math.abs(lv), 1e-9);
        compared++;
        if (rel > maxRel) {
          maxRel = rel;
          worst = row.day;
        }
      }
      const ok = maxRel <= TOL && missing === 0;
      if (!ok) failures++;
      console.log(
        `  ${metric}: compared=${compared}/${legacyByDay.size} maxRelΔ=${maxRel.toExponential(2)}${
          worst ? ` (worst ${worst})` : ""
        }${missing ? ` MISSING-IN-TABLE=${missing}` : ""} ${ok ? "OK" : "FAIL"}`,
      );
    }
  }

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
