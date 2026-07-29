/**
 * Slice-M live exercise: mint a genuinely NEW point and follow it publish → receive → aggregate →
 * serve, so the C7 FK (`point_readings.point_rid → points(rid)`) is actually exercised by a point that
 * did not exist before this run.
 *
 * It drives the REAL code: `mintPoint`, `buildObservations` (the publisher's payload builder — proving
 * the wire carries `pointUid` and no longer carries `debug.reference`), the receiver's own
 * `processQueueMessage`, the raw→5m recompute, and `ReadingsDao` reads for serving. The only links it
 * cannot drive are the QStash HTTP hop and its signature check: dev has no `OBSERVATIONS_QSTASH_*`
 * secrets, so the publisher no-ops and the receiver route 503s by design.
 *
 * WRITES — mints a throwaway point, writes two readings and their 5m aggregate, then deletes all of it.
 * Dev only; refuses if the connection carries the prod branch token.
 *
 *   npx tsx --env-file=.env.local scripts/config-v4/verify-slice-m-e2e.ts [systemId]
 */
import { and, eq, sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  pointInfo,
  pointReadings,
  pointReadingsAgg5m,
  points,
} from "@/lib/db/planetscale/schema";
import { mintPoint } from "@/lib/point/mint-point";
import { buildObservations } from "@/lib/observations/publisher";
import { SystemsManager } from "@/lib/systems-manager";
import {
  POST,
  type WithProcessQueueMessage,
} from "@/app/api/observations/receive/route";
import { recompute5mForRawObservationsBestEffort } from "@/lib/db/planetscale/aggregate-points-pg";
import { ReadingsDao } from "@/lib/readings";
import { Point } from "@/lib/ids";

const RUN = Date.now();
const STEM = `__slice-m-e2e__/${RUN}`;
const TAIL = `derived/${STEM}`;

async function main() {
  const db = planetscaleDb;
  if (!db) throw new Error("PLANETSCALE_DATABASE_URL not configured");
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  if (
    prodToken &&
    (process.env.PLANETSCALE_DATABASE_URL ?? "").includes(prodToken)
  )
    throw new Error(
      "refusing to run: connection carries the prod branch token",
    );

  const systemId = Number(process.argv[2] ?? 1) || 1;
  const system = await SystemsManager.getInstance().getSystem(systemId);
  if (!system) throw new Error(`no system ${systemId}`);
  const fail: string[] = [];

  // 1. MINT — a point that did not exist a moment ago.
  const pt = await mintPoint(systemId, {
    physicalPathTail: TAIL,
    logicalPathStem: STEM,
    metricType: "power",
    metricUnit: "W",
    defaultName: "slice-M e2e probe",
  });
  console.log(`minted: index=${pt.index} rid=${pt.rid} uid=${pt.pointUid}`);
  // `buildObservations` takes the served (epoch-ms) point shape, not the raw DB row.
  const servedPoint = {
    ...pt,
    createdAtMs: pt.createdAt?.getTime() ?? 0,
    updatedAtMs: pt.updatedAt?.getTime() ?? null,
  };

  const [mirror] = await db
    .select()
    .from(points)
    .where(eq(points.id, pt.pointUid));
  if (!mirror) fail.push("no `points` row for the freshly minted point");
  else if (mirror.rid !== pt.rid)
    fail.push(`points.rid ${mirror.rid} != point_info.rid ${pt.rid}`);
  else console.log(`points row present, rid ${mirror.rid} == point_info.rid`);

  // 2. PUBLISH — the real payload builder.
  const base = Math.floor(Date.now() / 300000) * 300000 - 600000;
  const sessionId = `slice-m-e2e-${RUN}`;
  const obs = buildObservations(system, [
    {
      sessionId,
      point: servedPoint,
      value: 111,
      measurementTimeMs: base,
      receivedTimeMs: base,
      interval: "raw",
    },
    {
      sessionId,
      point: servedPoint,
      value: 333,
      measurementTimeMs: base + 60000,
      receivedTimeMs: base + 60000,
      interval: "raw",
    },
  ]);
  if (obs[0].pointUid !== pt.pointUid) fail.push("payload lost the pointUid");
  if ((obs[0].debug as Record<string, unknown>)?.reference !== undefined)
    fail.push("payload still carries the retired debug.reference");
  console.log(
    `published payload: pointUid=${obs[0].pointUid}, debug keys=[${Object.keys(obs[0].debug ?? {})}]`,
  );

  // 3. RECEIVE — the receiver's own processQueueMessage (the QStash hop is undrivable in dev).
  const stats = await (POST as WithProcessQueueMessage).__processQueueMessage(
    db,
    {
      env: "dev",
      systemId,
      batchTime: new Date(base).toISOString(),
      // The real flow co-enqueues the session with its readings (point_readings.session_id FKs sessions).
      session: {
        sessionId,
        sessionLabel: null,
        cause: "ADMIN",
        started: new Date(base).toISOString(),
        durationMs: 1,
        successful: true,
        errorCode: null,
        error: null,
        response: null,
        numRows: 2,
      },
      observations: obs,
    } as never,
  );
  console.log(`receiver stats: ${JSON.stringify(stats)}`);
  if (stats.rawInserted !== 2)
    fail.push(`expected 2 raw inserted, got ${stats.rawInserted}`);
  if (stats.rawSkipped) fail.push(`receiver skipped ${stats.rawSkipped}`);

  const raw = await db
    .select()
    .from(pointReadings)
    .where(eq(pointReadings.pointRid, pt.rid));
  console.log(`point_readings rows for rid ${pt.rid}: ${raw.length}`);
  if (raw.length !== 2)
    fail.push(`expected 2 point_readings rows, got ${raw.length}`);

  // 4. AGGREGATE — the same best-effort raw→5m recompute the receiver runs after commit.
  await recompute5mForRawObservationsBestEffort(systemId, obs);
  const agg = await db
    .select()
    .from(pointReadingsAgg5m)
    .where(eq(pointReadingsAgg5m.pointRid, pt.rid));
  console.log(
    `agg_5m rows: ${agg.length}${agg.length ? ` (avg=${agg[0].avg}, n=${agg[0].sampleCount})` : ""}`,
  );
  if (agg.length < 1)
    fail.push("no agg_5m row — the aggregate leg did not run");

  // 5. SERVE — read it back through the DAO seam that every serving path uses.
  const served = await ReadingsDao.latestForPoints([Point.encode(pt.pointUid)]);
  const latest = served.get(Point.encode(pt.pointUid));
  console.log(`served latest: ${JSON.stringify(latest ?? null)}`);
  if (!latest) fail.push("the new point does not serve");

  // 6. CLEANUP.
  await db
    .delete(pointReadingsAgg5m)
    .where(eq(pointReadingsAgg5m.pointRid, pt.rid));
  await db.delete(pointReadings).where(eq(pointReadings.pointRid, pt.rid));
  await db.delete(points).where(eq(points.id, pt.pointUid));
  await db
    .delete(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.physicalPathTail, TAIL),
      ),
    );
  await db.execute(sql`DELETE FROM sessions WHERE id = ${sessionId}`);
  console.log("cleaned up");

  if (fail.length) {
    console.error("FAIL:\n  " + fail.join("\n  "));
    process.exit(1);
  }
  console.log("PASS — mint → publish → receive → aggregate → serve");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
