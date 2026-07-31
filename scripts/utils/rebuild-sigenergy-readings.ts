/**
 * Rebuild stored Sigenergy point readings from the ARCHIVED vendor payloads in `sessions.response`,
 * then re-derive the aggregates that depend on them.
 *
 * WHY THIS EXISTS
 * Three ingest defects (fixed 2026-07-28) left history wrong for every Sigenergy site:
 *   1. Both bidirectional channels were stored with the VENDOR's "outflow positive" sign instead of
 *      LiveOne's canonical "inflow positive" — see `sigenergyFlowToData`. Night-time battery
 *      discharge therefore landed on the load side, and `computeFlowAccounting` skipped every
 *      interval whose sources summed to <= 0, silently dropping ~2/3 of each day from the Sankey.
 *   2. EV charging was always stored as 0: `pickNumber` stopped at `evPower` (present-but-zero on an
 *      AC-charger site) and never reached the real `acPower`.
 *   3. `ev.charge` was not a recognised flow stem, so it never reached the matrix at all.
 * (3) is pure read-path. (1) and (2) are baked into stored readings, which is what this repairs.
 *
 * WHY REPLAY RATHER THAN NEGATE IN PLACE
 * Every `point_readings` row carries `session_id`, and on the live data all of them resolve (5346/5346,
 * 0 orphans). So each reading can be recomputed from the exact payload that produced it, through the
 * same `parseEnergyFlow` → `sigenergyFlowToData` pair the live poller uses. That makes this
 * IDEMPOTENT (re-running converges, it doesn't re-flip), lossless, and immune to drift if the field
 * mapping changes later. A blind `value = -value` would be none of those.
 *
 * SCOPE — this repairs the VALUES of existing readings. It does NOT invent rows: the archive holds
 * more sessions than there are readings (some polls predate the points, others failed), so
 * pre-existing coverage gaps survive untouched and our totals stay slightly under the vendor's.
 * That is deliberate; closing gaps is a coverage problem, not a sign problem.
 *
 * USAGE
 *   npx tsx --env-file=.env.local scripts/utils/rebuild-sigenergy-readings.ts            # dry run
 *   npx tsx --env-file=.env.local scripts/utils/rebuild-sigenergy-readings.ts --apply
 *   … [--device=13] [--from=2026-07-01] [--to=2026-07-29] [--skip-aggregates]
 *
 * Dry run is the default and reports exactly what would change, per point.
 */
import { and, eq, inArray } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { points, devices, sessions } from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings/dao";
import { Point } from "@/lib/ids";
import type { PointId } from "@/lib/ids/types";
import { parseEnergyFlow } from "@/lib/vendors/sigenergy/sigenergy-client";
import {
  SIGENERGY_POINTS,
  sigenergyFlowToData,
} from "@/lib/vendors/sigenergy/point-metadata";
import type { SigenergyData } from "@/lib/vendors/sigenergy/types";
import { recomputeAgg5mForIntervals } from "@/lib/db/planetscale/aggregate-points-pg";

const BATCH = 2000;

interface Args {
  apply: boolean;
  systemId?: number;
  from?: Date;
  to?: Date;
  skipAggregates: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const from = get("from");
  const to = get("to");
  return {
    apply: argv.includes("--apply"),
    systemId: get("system") ? Number(get("system")) : undefined,
    from: from ? new Date(`${from}T00:00:00Z`) : undefined,
    to: to ? new Date(`${to}T00:00:00Z`) : undefined,
    skipAggregates: argv.includes("--skip-aggregates"),
  };
}

/** `physicalPathTail` → the `SigenergyData` field carrying its value. */
const FIELD_BY_TAIL = new Map(
  SIGENERGY_POINTS.map((p) => [
    p.metadata.physicalPathTail,
    p.field as keyof SigenergyData,
  ]),
);

async function main() {
  const args = parseArgs();
  const db = planetscaleDb;
  if (!db)
    throw new Error("No Postgres connection (PLANETSCALE_DATABASE_URL).");

  // Resolve the Sigenergy points, keyed by rid, with the payload field each one maps to.
  const pointRows = await db
    .select({
      rid: points.rid,
      uuid: points.id,
      physicalPath: points.physicalPath,
      logicalPath: points.logicalPath,
      metricType: points.metricType,
      deviceRid: devices.rid,
    })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      args.systemId
        ? and(eq(devices.vendor, "sigenergy"), eq(devices.rid, args.systemId))
        : eq(devices.vendor, "sigenergy"),
    );

  const fieldByRid = new Map<number, keyof SigenergyData>();
  for (const p of pointRows) {
    // physical_path is the full path; the metadata key is its last segment.
    const tail = p.physicalPath.split(".").pop() ?? p.physicalPath;
    const field = FIELD_BY_TAIL.get(tail);
    if (field) fieldByRid.set(p.rid, field);
  }
  if (fieldByRid.size === 0) throw new Error("No Sigenergy points resolved");
  console.log(
    `Resolved ${fieldByRid.size} Sigenergy points across ${new Set(pointRows.map((p) => p.deviceRid)).size} device(s)`,
  );

  // Hot-table access goes through the readings seam (config-v4 Phase 3); the boundary gate in
  // scripts/check-readings-boundary.mjs enforces it. `sessions` is not a hot table, so the payload
  // archive is read directly and joined in memory by session id.
  //
  // The `PointId` comes straight off the row we already read — `points.id` IS the point uuid, and
  // `Point.encode` is the same codec `RegistryCache` applies to it. Going back through
  // `RegistryCache.pointForRid(rid)` needed a `PointRid`, which a bare `points.rid` is not (the
  // brand is what keeps the uuid↔rid seam honest), and cost one cold DB round trip PER POINT to
  // re-derive a uuid this query had already returned.
  const pointIdByRid = new Map<number, PointId>();
  for (const p of pointRows) {
    if (fieldByRid.has(p.rid)) pointIdByRid.set(p.rid, Point.encode(p.uuid));
  }

  // Per-point tallies so the dry run is readable: what actually moves, and by how much.
  const stats = new Map<
    number,
    { checked: number; changed: number; signFlips: number; zeroToValue: number }
  >();
  const touchedIntervals = new Map<number, Set<number>>(); // deviceRid -> interval-end ms
  const deviceByRid = new Map(pointRows.map((p) => [p.rid, p.deviceRid]));

  let noSession = 0;
  let unparseable = 0;
  const updates: {
    point: PointId;
    measurementTimeMs: number;
    value: number;
  }[] = [];

  const fromMs = (args.from ?? new Date("2000-01-01")).getTime();
  const toMs = (args.to ?? new Date("2100-01-01")).getTime();
  const series = await ReadingsDao.readRaw([...pointIdByRid.values()], {
    fromMs,
    toMs,
  });

  // Payloads for every session referenced by the readings, fetched in chunks.
  const sessionIds = [
    ...new Set(
      [...series.values()].flatMap((rows) =>
        rows.map((r) => r.sessionId).filter((s): s is string => s !== null),
      ),
    ),
  ];
  const responseById = new Map<string, unknown>();
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const chunk = sessionIds.slice(i, i + BATCH);
    const rows = await db
      .select({ id: sessions.id, response: sessions.response })
      .from(sessions)
      .where(inArray(sessions.id, chunk));
    for (const r of rows) responseById.set(r.id, r.response);
  }
  console.log(
    `Read ${[...series.values()].reduce((n, r) => n + r.length, 0)} readings and ${responseById.size} archived payloads`,
  );

  for (const [rid, point] of pointIdByRid) {
    const field = fieldByRid.get(rid);
    if (!field) continue;
    for (const r of series.get(point) ?? []) {
      const s = stats.get(rid) ?? {
        checked: 0,
        changed: 0,
        signFlips: 0,
        zeroToValue: 0,
      };
      s.checked++;
      stats.set(rid, s);

      const response = r.sessionId ? responseById.get(r.sessionId) : undefined;
      if (response == null) {
        noSession++;
        continue;
      }
      const flow = parseEnergyFlow(response);
      // A payload with none of these isn't an energyflow response (e.g. an auth/error session).
      if (
        flow.pvKw === null &&
        flow.loadKw === null &&
        flow.batterySoc === null
      ) {
        unparseable++;
        continue;
      }
      const data = sigenergyFlowToData(flow, new Date(r.measurementTimeMs));
      const expected = data[field];
      if (expected == null || typeof expected !== "number") continue;

      const current = Number(r.value);
      if (current === expected) continue;

      s.changed++;
      if (
        current !== 0 &&
        expected !== 0 &&
        Math.sign(current) !== Math.sign(expected)
      )
        s.signFlips++;
      if (current === 0 && expected !== 0) s.zeroToValue++;

      updates.push({
        point,
        measurementTimeMs: r.measurementTimeMs,
        value: expected,
      });

      const deviceRid = deviceByRid.get(rid);
      if (deviceRid != null) {
        const set = touchedIntervals.get(deviceRid) ?? new Set<number>();
        // 5m interval END that this reading falls in.
        set.add(Math.ceil(r.measurementTimeMs / 300_000) * 300_000);
        touchedIntervals.set(deviceRid, set);
      }
    }
  }

  console.log("\nPer-point summary:");
  for (const p of pointRows) {
    const s = stats.get(p.rid);
    if (!s) continue;
    console.log(
      `  ${p.logicalPath}/${p.metricType} (rid ${p.rid}): checked=${s.checked} changed=${s.changed}` +
        ` signFlips=${s.signFlips} zero→value=${s.zeroToValue}`,
    );
  }
  if (noSession)
    console.log(`  ${noSession} readings had no linked session (skipped)`);
  if (unparseable)
    console.log(
      `  ${unparseable} sessions were not energyflow payloads (skipped)`,
    );
  console.log(
    `\n${updates.length} reading(s) would change; ${[...touchedIntervals.values()].reduce((n, s) => n + s.size, 0)} 5m interval(s) affected`,
  );

  if (!args.apply) {
    console.log("\nDRY RUN — pass --apply to write.");
    process.exit(0);
  }

  console.log(`\nApplying ${updates.length} update(s)…`);
  const { updated } = await ReadingsDao.updateRawValues(updates);
  console.log(`  ${updated} row(s) updated`);

  if (args.skipAggregates) {
    console.log("\n--skip-aggregates: not re-deriving 5m/1d.");
    process.exit(0);
  }

  console.log("\nRe-deriving 5m aggregates…");
  for (const [deviceRid, intervals] of touchedIntervals) {
    const list = [...intervals].sort((a, b) => a - b);
    const { intervalsProcessed, rowsUpserted } =
      await recomputeAgg5mForIntervals(db, deviceRid, list);
    console.log(
      `  device ${deviceRid}: intervals=${intervalsProcessed} upserted=${rowsUpserted}`,
    );
  }

  console.log(
    "\nDONE (5m rebuilt). NEXT — 1d + provenance are NOT yet rebuilt; run:\n" +
      "  npx tsx --env-file=.env.local scripts/utils/regen-provenance-range.ts <areaUuid> <from> <to>\n" +
      "It clears the area's learned eta/capacity (fitted to the inverted signs) before re-aggregating;\n" +
      "skipping it leaves the corrected fold reading stale params.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
