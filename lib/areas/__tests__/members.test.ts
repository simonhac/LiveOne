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
  ensureAreaMember,
  listFlowEligibleAreaHandles,
  getBindinglessAreaMemberPoints,
} from "../members";

const dialect = new PgDialect();

/** Collapse whitespace so assertions read like the SQL, not like the template literal. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const captured: string[] = [];
const inserts: { table: string; values: unknown }[] = [];

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
  };
}

beforeEach(() => {
  captured.length = 0;
  inserts.length = 0;
  mockDb = makeFakeDb();
});

describe("membership DAO reads `area_members`, never `area_devices`", () => {
  it("getAreaMemberDeviceIds joins devices and orders by ordinal then rid", async () => {
    await getAreaMemberDeviceIds("area-a");
    const [sql] = captured;
    expect(sql).toContain('from "area_members"');
    expect(sql).toContain(
      'inner join "devices" on "devices"."id" = "area_members"."device_id"',
    );
    expect(sql).toContain('where "area_members"."area_id" = $1');
    // The tiebreak is rid, not device_id: uuid order is not int order, and members sharing an ordinal
    // must keep the ordering they had under `area_devices`.
    expect(sql).toContain(
      'order by "area_members"."ordinal" asc, "devices"."rid" asc',
    );
  });

  it("listFlowEligibleAreaHandles matches members through devices.rid", async () => {
    await listFlowEligibleAreaHandles();
    const [sql] = captured;
    expect(sql).toContain("FROM area_members am");
    expect(sql).toContain("JOIN devices d ON d.id = am.device_id");
    // The int handle comparison must go through devices.rid — the seam invariant devices.rid == systems.id.
    expect(sql).toContain('d.rid = "areas"."legacy_system_id"');
    expect(sql).toContain("parent.status = 'active'");
  });

  it("getBindinglessAreaMemberPoints bridges member uuid -> point_info.system_id via devices.rid", async () => {
    await getBindinglessAreaMemberPoints();
    const [sql] = captured;
    expect(sql).toContain(
      'inner join "area_members" on "area_members"."area_id" = "areas"."id"',
    );
    expect(sql).toContain(
      'inner join "devices" on "devices"."id" = "area_members"."device_id"',
    );
    expect(sql).toContain(
      'inner join "point_info" on "point_info"."system_id" = "devices"."rid"',
    );
  });

  it("ensureAreaMember writes area_members with the raw device uuid", async () => {
    const uuid = "018f0000-0000-7000-8000-000000000001";
    await ensureAreaMember(mockDb as never, "area-a", Device.encode(uuid), 7);
    expect(inserts).toEqual([
      {
        table: "area_members",
        values: { areaId: "area-a", deviceId: uuid, ordinal: 7 },
      },
    ]);
  });

  it("no query mentions the dropped table", async () => {
    // Guard against a half-done swap. `captured` resets per test, so re-drive all three reads here
    // rather than relying on the ones above.
    await getAreaMemberDeviceIds("area-a");
    await listFlowEligibleAreaHandles();
    await getBindinglessAreaMemberPoints();
    expect(captured).toHaveLength(3);
    for (const sql of captured) expect(sql).not.toContain("area_devices");
  });
});
