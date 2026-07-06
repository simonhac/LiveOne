#!/usr/bin/env tsx
/**
 * End-to-end smoke test for the self-serve **area builder** write path (lib/areas/create.ts), driving
 * the REAL serving resolver (`PointManager.getActivePointsForSystem` → `getViewableSystem` →
 * `_resolvePointsForViewable`). It creates a throwaway multi-device "site" area and asserts:
 *   1. a synthetic handle is allocated (≥ AREA_HANDLE_BASE, no real systems row);
 *   2. it resolves as an area view (`isAreaHandle`, vendorType "area");
 *   3. with no bindings, the point set is the UNION of its members' own points;
 *   4. with bindings, the point set is exactly the BOUND points (override);
 *   5. adding a member grows the union;
 *   6. removing the last member is refused.
 * Then it hard-deletes the area (area_devices + area_bindings cascade).
 *
 * Runs directly against the DB in .env.local — DEV only (the DB-env guard refuses a prod-token
 * connection). Bypasses HTTP/Clerk, so it needs no live session.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/area-builder-smoke.ts
 *   npx tsx --env-file=.env.local scripts/area-builder-smoke.ts --members=1,6
 */
import * as dotenv from "dotenv";
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
  const { areas } = await import("@/lib/db/planetscale/schema");
  const { createArea, addMember, replaceBindings, removeMember } = await import(
    "@/lib/areas/create"
  );
  const { AREA_HANDLE_BASE } = await import("@/lib/areas/handles");
  const { PointManager } = await import("@/lib/point/point-manager");
  const { SystemsManager } = await import("@/lib/systems-manager");
  const { getAreaBindingRefs } = await import("@/lib/areas/bindings");
  const { getAreaDeviceSystemIds } = await import("@/lib/areas/devices");
  const { eq } = await import("drizzle-orm");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres not configured (no PLANETSCALE_DATABASE_URL in .env.local).",
    );
    process.exit(1);
  }
  const db = requirePlanetscaleDb();
  const pm = PointManager.getInstance();
  const sm = SystemsManager.getInstance();

  const countPoints = async (id: number) =>
    (await pm.getActivePointsForSystem(id, false, false)).length;

  // Choose member devices: --members override, else auto-pick the first 3 active real systems that
  // have points.
  let members: number[];
  const override = getArg("members");
  if (override) {
    members = override.split(",").map((s) => parseInt(s.trim(), 10));
  } else {
    const active = await sm.getActiveSystems();
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
    });
    areaId = created.id;
    const H = created.legacySystemId;
    console.log(`Created area ${areaId} with handle ${H}`);
    assert(
      H > AREA_HANDLE_BASE,
      `handle ${H} is a synthetic handle (> ${AREA_HANDLE_BASE})`,
    );

    // 2. Resolver identity.
    assert(await sm.isAreaHandle(H), "isAreaHandle(handle) === true");
    const view = await sm.getViewableSystem(H);
    assert(
      view?.vendorType === "area",
      'getViewableSystem().vendorType === "area"',
    );
    assert(
      (await sm.getSystem(H)) === null,
      "no real systems row at the handle",
    );

    // 3. Union-default (no bindings) = sum of members' own points.
    const union = await countPoints(H);
    assert(
      union === expectedUnion,
      `union point count ${union} === sum of members' points ${expectedUnion}`,
    );

    // 4. Bindings override → exactly the bound points.
    const seedPoints = await pm.getActivePointsForSystem(seed[0], false, false);
    const p = seedPoints[0];
    const [ps, pid] = p.getReference().toString().split(".").map(Number);
    await replaceBindings(areaId, [
      {
        role: "load",
        metricType: p.metricType,
        pointSystemId: ps,
        pointId: pid,
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
      await addMember(areaId, extra);
      const ids = await getAreaDeviceSystemIds(areaId);
      assert(ids.includes(extra), `area_devices now includes ${extra}`);
      const grown = await countPoints(H);
      assert(
        grown === expectedUnion + (await countPoints(extra)),
        `union grew to ${grown} after adding member ${extra}`,
      );
    }

    // 6. Removing down to the last member is refused.
    const memberIds = await getAreaDeviceSystemIds(areaId);
    for (const m of memberIds.slice(1)) await removeMember(areaId, m);
    let refused = false;
    try {
      await removeMember(areaId, (await getAreaDeviceSystemIds(areaId))[0]);
    } catch {
      refused = true;
    }
    assert(refused, "removeMember refuses the last member");

    console.log("\n✅ ALL CHECKS PASSED");
  } finally {
    if (areaId) {
      await db.delete(areas).where(eq(areas.id, areaId));
      console.log(
        `\n🧹 Cleaned up area ${areaId} (members + bindings cascade).`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌", e);
    process.exit(1);
  });
