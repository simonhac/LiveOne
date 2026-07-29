/**
 * Slice-D parity gate: every point identity the new code reads from a uuid must equal the one the
 * retired `RegistryCache.pointForAddr(system_id, index)` lookup would have returned.
 *
 * Drives the REAL code paths (`boundPoints`, `resolveCoveragePoints`, `PointManager`,
 * `resolveLogicalSystem`) rather than re-deriving the mapping in SQL, so a mistake in the mapping
 * code itself is caught, not just a data mismatch. Read only — safe against any environment.
 *
 * This file is at its final shape. Slice M deleted the receiver's legacy `debug.reference` branch,
 * leaving ONE `pointForAddr` caller: `app/api/admin/point/[systemIdDotPointId]/readings/route.ts`,
 * which takes the address from the URL segment itself and so is not a mechanical conversion. The gate
 * DIES WITH `pointForAddr` itself — that is Phase 13, NOT slice M: while that route stands there is
 * still a legacy side to compare against, and this file must keep running.
 *
 *   npx tsx --env-file=.env.local scripts/config-v4/verify-slice-d-parity.ts
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  pointInfo,
  systems,
} from "@/lib/db/planetscale/schema";
import { boundPoints } from "@/lib/battery-provenance/load";
import { resolveCoveragePoints } from "@/lib/coverage/find-gaps";
import { PointManager } from "@/lib/point/point-manager";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import { listFlowEligibleAreaHandles } from "@/lib/areas/members";
import { RegistryCache, UnknownIdError } from "@/lib/registry";
import { Point, type PointId } from "@/lib/ids";

const db = planetscaleDb!;

/** What the retired lookup would have returned for a legacy address. */
async function legacy(
  systemId: number,
  index: number,
): Promise<PointId | null> {
  try {
    return await RegistryCache.pointForAddr(systemId, index);
  } catch (e) {
    if (e instanceof UnknownIdError) return null;
    throw e;
  }
}

let checked = 0;
let mismatched = 0;

function compare(what: string, got: PointId | null, want: PointId | null) {
  checked++;
  if (got !== want) {
    mismatched++;
    console.error(`MISMATCH ${what}: new=${got} legacy=${want}`);
  }
}

async function main() {
  // 0. Binding reachability. This USED to count NULL `point_uid`s, which migration 0047 made
  //    unrepresentable — a check the DB now enforces is a check this script should stop pretending to
  //    perform. What is still NOT enforced anywhere is that a binding's point exists in `point_info`:
  //    `point_uid` FKs `points`, and 0047 dropped the last FK into `point_info`, so the two tables can
  //    diverge silently. That divergence is load-bearing since slice E PR 2b, because
  //    `getAreaBindings` now joins `point_info` on `point_uid` to recover the source system — an
  //    unreachable binding contributes NO KV subscription edge and the area just stops updating, with
  //    no error anywhere. Cheap to assert, invisible otherwise.
  const [{ total, unreachable }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unreachable: sql<number>`count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM point_info pi WHERE pi.point_uid = ${areaBindings.pointUid}
      ))::int`,
    })
    .from(areaBindings);
  if (unreachable > 0) {
    console.error(
      `UNREACHABLE BINDINGS: ${unreachable}/${total} area_bindings rows name a point_uid with no ` +
        `point_info row — those bindings resolve to nothing and drop out of the KV subscription map.`,
    );
    mismatched += unreachable;
  } else {
    console.log(`area_bindings → point_info reachable: ${total}/${total}`);
  }

  // 1. boundPoints() — the battery-provenance membership read, now sourced from area_bindings.point_uid.
  const areaRows = await db.select({ id: areas.id }).from(areas);
  for (const a of areaRows) {
    for (const bp of await boundPoints(db, a.id)) {
      compare(
        `binding area=${a.id} ${bp.role}/${bp.metric} (${bp.systemId}.${bp.pointId})`,
        bp.point,
        await legacy(bp.systemId, bp.pointId),
      );
    }
  }

  // 2. resolveCoveragePoints() — now carries point_uid straight off the row it already selected.
  const sysRows = await db
    .selectDistinct({ systemId: pointInfo.systemId })
    .from(pointInfo);
  for (const { systemId } of sysRows) {
    const tails = (
      await db
        .select({ tail: pointInfo.physicalPathTail })
        .from(pointInfo)
        .where(eq(pointInfo.systemId, systemId))
    ).map((r) => r.tail);
    for (const cp of await resolveCoveragePoints(db, systemId, tails)) {
      compare(
        `coverage ${systemId}.${cp.id} (${cp.tail})`,
        cp.point,
        await legacy(systemId, cp.id),
      );
    }
  }

  // 3. PointManager.getActivePointsForSystem() — the producer behind the amber vendor site AND
  //    (via resolveLogicalSystem) the flow site and /api/history's series. `PointInfo` now carries
  //    `pointUid`, so this one sweep covers every consumer of the class at once. Run over every
  //    viewable handle, real devices and area handles alike, since the area branch resolves points
  //    through a different query (the area_bindings OR-of-pairs) than the own-points branch.
  const handles = [
    ...new Set([
      ...(await db.select({ id: systems.id }).from(systems)).map((r) => r.id),
      ...(
        await db
          .select({ h: areas.legacySystemId })
          .from(areas)
          .where(isNotNull(areas.legacySystemId))
      ).map((r) => r.h!),
    ]),
  ].sort((a, b) => a - b);

  const pm = PointManager.getInstance();
  for (const handle of handles) {
    let pts;
    try {
      pts = await pm.getActivePointsForSystem(handle, false);
    } catch {
      continue; // not a viewable handle (e.g. a removed device) — nothing to compare
    }
    for (const p of pts) {
      compare(
        `point handle=${handle} ${p.systemId}.${p.index} (${p.name})`,
        Point.encode(p.pointUid),
        await legacy(p.systemId, p.index),
      );
    }
  }

  // 4. resolveLogicalSystem() — proves the threading of the identity onto `LogicalSystemPoint`,
  //    which block 3 does not: a mapper that dropped `point` would still leave block 3 green.
  //    Both lists, because `energyPoints` is a separate map with its own copy of the expression.
  for (const handle of await listFlowEligibleAreaHandles()) {
    const ls = await resolveLogicalSystem(handle);
    if (!ls) continue;
    for (const [kind, list] of [
      ["points", ls.points],
      ["energyPoints", ls.energyPoints],
    ] as const) {
      for (const lp of list) {
        compare(
          `ls ${handle}/${kind} ${lp.ref.systemId}.${lp.ref.pointId} (${lp.stem})`,
          lp.point,
          await legacy(lp.ref.systemId, lp.ref.pointId),
        );
      }
    }
  }

  // 5. getPointByPhysicalPathTail() — the enphase producer. It returns a `PointInfoRow`, which has
  //    always carried `pointUid`; the two enphase sites were round-tripping anyway.
  for (const { systemId, tail } of await db
    .selectDistinct({
      systemId: pointInfo.systemId,
      tail: pointInfo.physicalPathTail,
    })
    .from(pointInfo)
    .where(eq(pointInfo.physicalPathTail, "solar_w"))) {
    const row = await pm.getPointByPhysicalPathTail(systemId, tail);
    if (!row) continue;
    compare(
      `physicalPathTail ${systemId}/${tail}`,
      Point.encode(row.pointUid),
      await legacy(systemId, row.index),
    );
  }

  console.log(
    `\n${checked} identities compared, ${mismatched} mismatched — ${mismatched === 0 ? "PARITY HOLDS" : "FAILED"}`,
  );
  process.exit(mismatched === 0 ? 0 : 1);
}

void main();
