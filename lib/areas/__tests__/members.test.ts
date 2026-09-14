/**
 * Rendered-SQL pin for the membership DAO (config-v4 Phase 12 slice H).
 *
 * Two of these four queries carry hand-written `sql` fragments that `tsc` cannot see into, and the
 * failure mode is silent: a stale table or column name resolves an area to FEWER points rather than
 * raising, so a dashboard quietly loses a member. This renders each query through the real
 * `PgDialect` — the same trick as `lib/__tests__/polling-utils-device-state.test.ts` — and asserts the
 * SQL actually emitted, not the shape of the builder chain.
 *
 * The schema is deliberately NOT mocked: the point is to catch a drift between these queries and
 * `schema.ts`.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";

let mockDb: unknown = null;
jest.mock("@/lib/db/planetscale", () => ({
  get planetscaleDb() {
    return mockDb;
  },
  requirePlanetscaleDb() {
    if (!mockDb) throw new Error("[PlanetScale] not configured (test)");
    return mockDb;
  },
}));

import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { Device } from "@/lib/ids";
import {
  getAreaMemberDeviceIds,
  setDeviceArea,
  listFlowEligibleAreaHandles,
  getAreaMemberPointsForServing,
} from "../members";

const dialect = new PgDialect();

/** Collapse whitespace so assertions read like the SQL, not like the template literal. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const captured: string[] = [];
const inserts: { table: string; values: unknown }[] = [];
const updates: { table: string; set: Record<string, unknown> }[] = [];

/**
 * A fake db that delegates every read to a REAL drizzle `QueryBuilder` (which needs no pool) and
 * renders at `orderBy` — the terminal call of all three reads. Writes are captured separately.
 */
function makeFakeDb() {
  const wrap = (node: any): any => ({
    from: (...a: any[]) => wrap(node.from(...a)),
    innerJoin: (...a: any[]) => wrap(node.innerJoin(...a)),
    where: (...a: any[]) => wrap(node.where(...a)),
    orderBy: (...a: any[]) => {
      captured.push(flat(dialect.sqlToQuery(node.orderBy(...a).getSQL()).sql));
      return Promise.resolve([]);
    },
  });
  return {
    select: (projection: any) =>
      wrap((new QueryBuilder().select as any)(projection)),
    insert: (table: any) => {
      const chain: any = {
        values: (v: unknown) => {
          inserts.push({ table: table[Symbol.for("drizzle:Name")], values: v });
          return chain;
        },
        onConflictDoNothing: () => Promise.resolve(),
      };
      return chain;
    },
    update: (table: any) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table: table[Symbol.for("drizzle:Name")], set: v });
          return Promise.resolve();
        },
      }),
    }),
  };
}

beforeEach(() => {
  captured.length = 0;
  inserts.length = 0;
  updates.length = 0;
  mockDb = makeFakeDb();
});

describe("membership DAO reads and writes `devices.area_id`, never `area_members`", () => {
  it("getAreaMemberDeviceIds reads the devices column and orders helper-last, then rid", async () => {
    await getAreaMemberDeviceIds("area-a");
    const [sql] = captured;
    // 🛑 Migration 0071 moved the edge onto `devices.area_id`, and Stage 4 stopped writing
    // `area_members` altogether. A read that slid back to the frozen table would keep working and
    // silently answer with the pre-flip membership.
    expect(sql).toContain('from "devices"');
    expect(sql).toContain('where "devices"."area_id" = $1');
    expect(sql).not.toContain("area_members");
    // Reproduces the retired `(area_members.ordinal, devices.rid)` order exactly: every helper
    // carried ordinal 99 so it sorted last, and no other ordinal changed the relative order of the
    // members that survive the flip. The tiebreak is rid, not device_id — uuid order is not int order.
    expect(sql).toContain('order by "devices"."vendor" = ');
    expect(sql).toContain('"devices"."rid" asc');
  });

  it("listFlowEligibleAreaHandles matches members through devices.rid", async () => {
    await listFlowEligibleAreaHandles();
    const [sql] = captured;
    expect(sql).toContain("FROM devices d");
    expect(sql).toContain("JOIN areas parent ON parent.id = d.area_id");
    expect(sql).not.toContain("area_members");
    // The int handle comparison must go through devices.rid — the seam invariant devices.rid == systems.id.
    // config-v4 Phase 13 PR 5: the handle side is `legacy_handles.handle`, not the dropped
    // `areas.legacy_system_id`. Raw `sql`, so tsc cannot see either side of this — hence the assertion.
    expect(sql).toContain('d.rid = "legacy_handles"."handle"');
    expect(sql).not.toContain("legacy_system_id");
    // The PARENT's handle needs its own satellite hop, or the "a different active area owns the flow
    // view" guard compares against nothing and every area looks flow-eligible.
    expect(sql).toContain("JOIN legacy_handles plh ON plh.area_id = parent.id");
    expect(sql).toContain('plh.handle <> "legacy_handles"."handle"');
    expect(sql).toContain("parent.status = 'active'");
  });

  it("getAreaMemberPointsForServing reaches member points through the points.device_id FK", async () => {
    await getAreaMemberPointsForServing();
    const [sql] = captured;
    // One join shallower than the `area_members` hop it replaces.
    expect(sql).toContain(
      'inner join "devices" on "devices"."area_id" = "areas"."id"',
    );
    expect(sql).not.toContain("area_members");
    // slice 1b: was `point_info.system_id = devices.rid`, a join through the integer handle. Points-
    // primary joins the real FK instead, so the member bridge no longer passes through an int at all.
    expect(sql).toContain(
      'inner join "points" on "points"."device_id" = "devices"."id"',
    );
  });

  it("getAreaMemberPointsForServing keeps the trap-D-l guard and drops the binding-less filter", async () => {
    await getAreaMemberPointsForServing();
    const [sql] = captured;
    // 🛑 Regression pin. This NOT EXISTS is the SQL twin of `_resolvePointsForHandle`'s device-first
    // dispatch: without it a colliding handle (a device AND an area sharing an int) fans out points
    // the serving path resolves to the device. Raw `sql`, invisible to tsc.
    expect(sql).toContain(
      'NOT EXISTS (SELECT 1 FROM devices d WHERE d.rid = "legacy_handles"."handle")',
    );
    // The defect: this predicate made bindings a VISIBILITY FILTER, so an area with bindings served
    // none of its member points and a point minted after the bindings were authored joined nothing.
    expect(sql).not.toContain("area_bindings");
    // A stemless point has no latest-hash field name, so its edge was always inert.
    expect(sql).toContain('"points"."logical_path" is not null');
    // The classifier needs the path, the metric and a human-recognisable id.
    expect(sql).toContain('"points"."logical_path"');
    expect(sql).toContain('"points"."metric_type"');
    expect(sql).toContain('"points"."rid"');
  });

  it("setDeviceArea UPDATES devices.area_id and inserts nothing", async () => {
    const uuid = "018f0000-0000-7000-8000-000000000001";
    await setDeviceArea(mockDb as never, Device.encode(uuid), "area-a");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("devices");
    expect(updates[0].set.areaId).toBe("area-a");
    // 🛑 The write is the whole of membership now. An `area_members` insert here would re-open the
    // dual-write the flip closed, and the two tables would disagree on the first re-home.
    expect(inserts).toEqual([]);
  });

  it("setDeviceArea(null) makes a device ambient rather than deleting a row", async () => {
    const uuid = "018f0000-0000-7000-8000-000000000002";
    await setDeviceArea(mockDb as never, Device.encode(uuid), null);
    expect(updates).toEqual([
      expect.objectContaining({
        table: "devices",
        set: expect.objectContaining({ areaId: null }),
      }),
    ]);
  });

  it("no query mentions the dropped table", async () => {
    // Guard against a half-done swap. `captured` resets per test, so re-drive all three reads here
    // rather than relying on the ones above.
    await getAreaMemberDeviceIds("area-a");
    await listFlowEligibleAreaHandles();
    await getAreaMemberPointsForServing();
    expect(captured).toHaveLength(3);
    for (const sql of captured) expect(sql).not.toContain("area_devices");
  });
});
