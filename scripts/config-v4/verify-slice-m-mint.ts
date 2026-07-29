/**
 * Slice-M mint gate: prove that `mintPoint` is (a) mirror-complete and (b) race-free.
 *
 * The allocator it replaced read `max(point_info.index)+1` from the same store it wrote, so two
 * concurrent mints of the same new `physical_path_tail` on one system raced to the same index and one
 * of them died on the composite primary key. Under slice M the index comes from `points.rid`'s own
 * sequence DEFAULT, so the two mints must converge on ONE row.
 *
 * WRITES — it mints a throwaway point and deletes it again. Run it against `liveone-dev` ONLY; it
 * refuses if the connection carries the prod branch token.
 *
 *   npx tsx --env-file=.env.local scripts/config-v4/verify-slice-m-mint.ts [systemId]
 */
import { and, eq, sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointInfo, points } from "@/lib/db/planetscale/schema";
import { mintPoint } from "@/lib/point/mint-point";

const TAIL = `derived/__slice-m-probe__/${Date.now()}`;

async function main() {
  const db = planetscaleDb;
  if (!db) throw new Error("PLANETSCALE_DATABASE_URL not configured");

  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID;
  const url = process.env.PLANETSCALE_DATABASE_URL ?? process.env.DB_USER ?? "";
  if (prodToken && url.includes(prodToken)) {
    throw new Error(
      "refusing to run: connection carries the prod branch token",
    );
  }

  const systemId = Number(process.argv[2] ?? 0) || undefined;
  const target =
    systemId ??
    (
      await db
        .select({ id: pointInfo.systemId })
        .from(pointInfo)
        .orderBy(pointInfo.systemId)
        .limit(1)
    )[0]?.id;
  if (!target) throw new Error("no system to test against");
  console.log(`system ${target}, tail ${TAIL}`);

  const spec = {
    physicalPathTail: TAIL,
    logicalPathStem: "__slice-m-probe__",
    metricType: "power",
    metricUnit: "W",
    defaultName: "slice-M probe",
  };

  // THE RACE: two simultaneous mints of the same brand-new tail.
  const [a, b] = await Promise.all([
    mintPoint(target, spec),
    mintPoint(target, spec),
  ]);
  console.log(
    `mint A: index=${a.index} rid=${a.rid} uid=${a.pointUid}\n` +
      `mint B: index=${b.index} rid=${b.rid} uid=${b.pointUid}`,
  );

  const fail: string[] = [];
  if (a.rid !== b.rid)
    fail.push(`concurrent mints diverged: ${a.rid} vs ${b.rid}`);
  if (a.index !== a.rid) fail.push(`index != rid (${a.index} != ${a.rid})`);

  const piRows = await db
    .select()
    .from(pointInfo)
    .where(
      and(eq(pointInfo.systemId, target), eq(pointInfo.physicalPathTail, TAIL)),
    );
  if (piRows.length !== 1)
    fail.push(`expected 1 point_info row, got ${piRows.length}`);

  const ptRows = await db
    .select()
    .from(points)
    .where(eq(points.id, a.pointUid));
  if (ptRows.length !== 1)
    fail.push(`expected 1 points row, got ${ptRows.length}`);
  else {
    if (ptRows[0].rid !== a.rid)
      fail.push(`points.rid ${ptRows[0].rid} != point_info.rid ${a.rid}`);
    if (ptRows[0].physicalPath !== TAIL)
      fail.push("points.physical_path mismatch");
  }

  // Idempotence: a third mint must return the same identity, not a new one.
  const c = await mintPoint(target, spec);
  if (c.rid !== a.rid) fail.push(`re-mint allocated a new rid: ${c.rid}`);

  // Cleanup.
  await db.delete(points).where(eq(points.id, a.pointUid));
  await db
    .delete(pointInfo)
    .where(
      and(eq(pointInfo.systemId, target), eq(pointInfo.physicalPathTail, TAIL)),
    );
  console.log("cleaned up probe rows");

  // Standing invariant, post-run.
  const [{ orphans }] = (
    await db.execute(sql`
      SELECT count(*)::int AS orphans FROM point_info pi
      WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.rid = pi.rid)`)
  ).rows as unknown as { orphans: number }[];
  if (orphans !== 0)
    fail.push(`${orphans} point_info rows without a points row`);
  console.log(`point_info rows lacking a points row: ${orphans}`);

  if (fail.length) {
    console.error("FAIL:\n  " + fail.join("\n  "));
    process.exit(1);
  }
  console.log("PASS — one row, index == rid, mirror complete, idempotent");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
