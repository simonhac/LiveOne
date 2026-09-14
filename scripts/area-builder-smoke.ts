#!/usr/bin/env tsx
/**
 * End-to-end smoke test for the self-serve **area builder** write path (lib/areas/create.ts), driving
 * the REAL serving resolver (`PointManager.getActivePointsForDevice` → `_resolvePointsForHandle`).
 * It creates a throwaway multi-device "site" area and asserts:
 *   1. a synthetic handle is allocated (≥ AREA_HANDLE_BASE, no real devices row);
 *   2. the handle resolves to an area and to NO device (`areaByHandle` / `deviceByHandle`);
 *   3. with no bindings, the point set is the UNION of its members' own points;
 *   4. with bindings, the point set is exactly the BOUND points (override);
 *   5. adding a member grows the union;
 *   6. an area can be emptied of every member.
 * Then it hard-deletes the area (area_bindings cascade).
 *
 * 🛑 **This run MOVES real devices, and it has to put them back.** Membership is `devices.area_id`
 * since migration 0071: a device is in at most one area, so pulling one into the throwaway site
 * takes it OUT of the site it actually belongs to, and step 6 then leaves it ambient. Before the
 * device→0..1-area change this script was read-only with respect to existing membership — adding a
 * member was purely additive, so there was nothing to restore. Now there is, so the `finally`
 * restores every borrowed device's original `area_id` BEFORE deleting the throwaway area (the FK is
 * `ON DELETE SET NULL`, which would otherwise silently orphan anything still pointing at it).
 *
 * Runs directly against the DB in .env.local — DEV only (the DB-env guard refuses a prod-token
 * connection). Bypasses HTTP/Clerk, so it needs no live session.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/area-builder-smoke.ts
 *   npx tsx --env-file=.env.local scripts/area-builder-smoke.ts --members=1,6
 */
import * as dotenv from "dotenv";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import {
  assertNoStaleJournal,
  captureWorld,
  clearJournal,
  restoreWorld,
} from "@/scripts/utils/smoke-world-snapshot";
dotenv.config({ path: ".env.local" });

function getArg(name: string): string | undefined {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : undefined;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const { planetscaleDb, requirePlanetscaleDb } = await import(
    "@/lib/db/planetscale"
  );
  const {
    areaBindings,
    areas,
    devices,
    legacyHandles,
    points: pointsTable,
  } = await import("@/lib/db/planetscale/schema");
  const { createArea, addMember, replaceBindings, removeMember } = await import(
    "@/lib/areas/create"
  );
  const { AREA_HANDLE_BASE } = await import("@/lib/areas/handles");
  const { PointManager } = await import("@/lib/point/point-manager");
  const { getAreaBindingRefs } = await import("@/lib/areas/bindings");
  const { Point } = await import("@/lib/ids");
  const { getAreaMemberDeviceIds } = await import("@/lib/areas/members");
  const { DeviceRegistry } = await import("@/lib/registry");
  const { bindingShapeMatches } = await import("@/lib/areas/slots");
  const { ROLES } = await import("@/lib/roles/registry");
  type RoleId = import("@/lib/roles/registry").RoleId;
  const { eq, inArray } = await import("drizzle-orm");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres not configured (no PLANETSCALE_DATABASE_URL in .env.local).",
    );
    process.exit(1);
  }
  const db = requirePlanetscaleDb();
  const pm = PointManager.getInstance();

  // 🛑 FIRST, before a single read and before any work. A journal left by an interrupted run means
  // the database may still be holding borrowed devices; this REFUSES rather than replaying it, and
  // prints the deliberate restore command. Replaying a whole-config photograph automatically would
  // revert anything that legitimately changed since — see `smoke-world-snapshot.ts`.
  const JOURNAL = "/tmp/liveone-area-builder-smoke-world.json";
  assertNoStaleJournal(JOURNAL);

  const countPoints = async (id: number) =>
    (await pm.getActivePointsForDevice(id, false, false)).length;

  // Membership is uuid-keyed since slice H; this script asserts in integer handles, so convert.
  // Declared `number[]`, not the inferred `DeviceRid[]`: everything this script feeds the handles to
  // (`addMember`/`removeMember`/`getActivePointsForDevice`) takes a plain handle, and `--members=`
  // supplies them as parsed CLI integers. Leaving the brand on made `ids.includes(extra)` a type
  // error and would have forced a cast on the CLI path — dodging the brand rather than respecting it.
  const memberHandles = async (id: string): Promise<number[]> => {
    const deviceIds = await getAreaMemberDeviceIds(id);
    const rids = await DeviceRegistry.ridsForDevices(deviceIds);
    return deviceIds.map((d) => rids.get(d)!);
  };

  // Choose member devices: --members override, else auto-pick the first 3 active real devices that
  // have points.
  let members: number[];
  const override = getArg("members");
  if (override) {
    members = override.split(",").map((s) => parseInt(s.trim(), 10));
  } else {
    const active = await DeviceConfigRegistry.activeDevices();
    const withPoints: number[] = [];
    for (const s of active) {
      if ((await countPoints(s.id)) > 0) withPoints.push(s.id);
      if (withPoints.length >= 3) break;
    }
    members = withPoints;
  }
  if (members.length < 2) {
    console.error(
      `❌ Need ≥2 member devices with points; found ${members.length}. Pass --members=a,b.`,
    );
    process.exit(1);
  }
  const seed = members.slice(0, 2);
  const extra = members[2]; // may be undefined
  console.log(
    `Members: seed=${seed.join(",")}${extra ? `  extra=${extra}` : ""}\n`,
  );

  // 🛑 Journalled HERE, not at startup: everything above is validation that can exit without
  // touching anything, and a journal left by a run that mutated nothing is pure litter — the next
  // run would refuse on it for no reason. The next statement is the first write.
  const world = await captureWorld(JOURNAL);
  const uuidByRid = new Map<number, string>();
  for (const rid of members)
    uuidByRid.set(rid, await DeviceRegistry.uuidForRid(rid, db));
  const placedAt = new Map(world.placements);
  console.log(
    `Snapshot: ${world.placements.length} placement(s), ${world.bindings.length} binding(s) → ${JOURNAL}\n`,
  );

  let areaId: string | null = null;
  try {
    // 1. Create the site.
    const seedCounts = await Promise.all(seed.map(countPoints));
    const expectedUnion = seedCounts.reduce((a, b) => a + b, 0);
    const created = await createArea({
      ownerClerkUserId: "area-builder-smoke",
      displayName: "SMOKE TEST — delete me",
      alias: null,
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Melbourne",
      location: null,
      memberSystemIds: seed,
      // This script IS the authorization — it drives the DAO directly, below HTTP. The map states
      // where it observed each member, which is exactly what the move is scoped on.
      authorized: new Map(
        seed.map((rid) => [
          uuidByRid.get(rid)!,
          placedAt.get(uuidByRid.get(rid)!) ?? null,
        ]),
      ),
    });
    areaId = created.id;
    const H = created.legacySystemId;
    console.log(`Created area ${areaId} with handle ${H}`);
    assert(
      H > AREA_HANDLE_BASE,
      `handle ${H} is a synthetic handle (> ${AREA_HANDLE_BASE})`,
    );

    // 2. Resolver identity. Phase 13 PR 2 deleted `isAreaHandle`/`viewableByHandle` (and with them the
    // fabricated `vendorType === "area"` view); the two real readers say the same thing more directly —
    // an area exists at the handle, and no device does. That conjunction IS what `isAreaHandle` was.
    assert(
      (await DeviceConfigRegistry.areaByHandle(H)) !== null,
      "areaByHandle(handle) resolves the new area",
    );
    assert(
      (await DeviceConfigRegistry.deviceByHandle(H)) === null,
      "no device of its own at the handle",
    );

    // 3. Union-default (no bindings) = sum of members' own points.
    const union = await countPoints(H);
    assert(
      union === expectedUnion,
      `union point count ${union} === sum of members' points ${expectedUnion}`,
    );

    // 4. Bindings override → exactly the bound points.
    //    The point must SATISFY the role it is bound to — `replaceBindings` enforces shape, so a blind
    //    `seedPoints[0]` fails whenever the first point happens to be, say, a `proportion` metric.
    //    Search for a (role, point) pair that actually matches rather than assuming one.
    const seedPoints = await pm.getActivePointsForDevice(seed[0], false, false);
    let chosen: { role: RoleId; point: (typeof seedPoints)[number] } | null =
      null;
    for (const point of seedPoints) {
      const role = (Object.keys(ROLES) as RoleId[]).find((r) =>
        bindingShapeMatches(r, point.metricType, point),
      );
      if (role) {
        chosen = { role, point };
        break;
      }
    }
    if (!chosen)
      throw new Error(
        `No point on system ${seed[0]} satisfies any role's shape — pass --members with a device that has role-shaped points.`,
      );
    const p = chosen.point;
    console.log(
      `  · binding ${p.logicalPathStem}/${p.metricType} as role "${chosen.role}"`,
    );
    await replaceBindings(areaId, [
      {
        role: chosen.role,
        metricType: p.metricType,
        // The wire names the point directly now (slice E PR 2b) — no "{sys}.{index}" to split.
        pointId: Point.encode(p.pointUid),
      },
    ]);
    const bound = await countPoints(H);
    assert(bound === 1, `bound point count ${bound} === 1 (override)`);
    assert(
      (await getAreaBindingRefs(H)).length === 1,
      "getAreaBindingRefs(handle) === 1 row",
    );

    // 5. Clear bindings, add a member → union grows.
    await replaceBindings(areaId, []);
    assert(
      (await countPoints(H)) === expectedUnion,
      "cleared bindings → union restored",
    );
    if (extra) {
      await addMember(
        areaId,
        extra,
        new Map([
          [uuidByRid.get(extra)!, placedAt.get(uuidByRid.get(extra)!) ?? null],
        ]),
      );
      const ids = await memberHandles(areaId);
      assert(ids.includes(extra), `area_members now includes ${extra}`);
      const grown = await countPoints(H);
      assert(
        grown === expectedUnion + (await countPoints(extra)),
        `union grew to ${grown} after adding member ${extra}`,
      );
    }

    // 6. Removing every member is ALLOWED — a zero-device area is first-class since Stage 4 of the
    // device→0..1-area change, which is what lets "hide areas-of-one" become the structural "hide
    // areas with zero devices". Removal ORPHANS: the devices keep their rows, with `area_id` NULL.
    for (const m of await memberHandles(areaId)) await removeMember(areaId, m);
    assert(
      (await memberHandles(areaId)).length === 0,
      "an area can be emptied of every member",
    );
    assert(
      (await countPoints(H)) === 0,
      "an emptied area resolves to no points at all",
    );

    console.log("\n✅ ALL CHECKS PASSED");
  } finally {
    // Put every borrowed device back where it was, FIRST. `devices.area_id` is ON DELETE SET NULL,
    // so deleting the throwaway area below would otherwise silently leave them ambient — and a
    // wrapped cleanup means the operator would see the smoke run pass while dev quietly lost its
    // membership. Wrapped so a restore failure cannot impersonate a test failure — but LOUD, and it
    // vetoes the delete below.
    // 🛑 Put the WORLD back before deleting anything. `devices.area_id` is ON DELETE SET NULL, so
    // deleting the scratch area first would strand whatever is still in it — and the journal is the
    // only record of where it belonged.
    const restored = await restoreWorld(world);
    if (!restored) {
      console.error(
        `\n❌ NOT deleting area ${areaId}: the world snapshot could not be fully restored. The ` +
          `journal is at ${JOURNAL} — fix the cause and re-run, which will restore from it.`,
      );
      process.exitCode = 1;
    } else if (areaId) {
      // `legacy_handles.area_id` is NO ACTION, not CASCADE, so the handle row must go first — without
      // this the delete throws and, being in a `finally`, MASKS whatever the body actually failed on.
      // The cleanup is also wrapped: a cleanup failure must never impersonate a test failure.
      try {
        await db.delete(legacyHandles).where(eq(legacyHandles.areaId, areaId));
        await db.delete(areas).where(eq(areas.id, areaId));
        console.log(
          `\n🧹 Cleaned up area ${areaId} (members + bindings cascade).`,
        );
      } catch (cleanupErr) {
        console.error(`\n⚠️  Cleanup of area ${areaId} FAILED:`, cleanupErr);
      }
      // Only once the world is back AND the scratch area is gone is the journal redundant.
      clearJournal(JOURNAL);
    }
  }
}

main()
  // 🛑 `process.exitCode`, not a hardcoded 0. The cleanup sets `exitCode = 1` when it could not put a
  // borrowed device back, and `process.exit(0)` here OVERRODE it — so a run that left real devices
  // displaced on a shared database reported success to the operator and to CI. Found in review.
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("\n❌", e);
    process.exit(1);
  });
