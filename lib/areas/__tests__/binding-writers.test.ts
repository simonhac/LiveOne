/**
 * `area_bindings` writers must populate `point_uid` (config-v4 Phase 12 slice E).
 *
 * Why this test exists: `point_uid` was NULLABLE until slice E's contract migration, so omitting it was
 * neither a type error nor a runtime error — the row just landed with NULL. Slice D PR 1 re-pointed
 * `boundPoints` (`lib/battery-provenance/load.ts`) at `point_uid` and maps a NULL to `null`, which
 * inherits the old not-in-registry MISS semantics: the point is silently dropped from the Area's
 * curated set. `replaceBindings` is delete-all-then-reinsert, so a single edit through the admin area
 * editor would have nulled every binding in that area.
 *
 * This is the fifth instance of the "wired at mint, not at edit" defect class (slice A2 found three,
 * slice H a fourth). The generalisation: when a column is added for a v4 read path, assert every
 * WRITER names it — the compiler cannot, and the failure is silent under-resolution, not an error.
 *
 * Asserts the values handed to the INSERT rather than rendered SQL: drizzle omits an absent column
 * from the statement entirely, so the values object is where the omission is actually visible.
 *
 * Slice E PR 2b turns the assertion around as well: the writers must now name NEITHER
 * `pointSystemId` NOR `pointId`, because migration 0048 drops those columns and naming a dropped
 * column is a runtime 42703, not a type error (drizzle's insert type is structural over the schema
 * object, so a stale writer would only fail in prod).
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

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

jest.mock("../members", () => ({
  getAreaMemberDeviceIds: async () => ["dv_member"],
}));

jest.mock("@/lib/registry", () => ({
  DeviceRegistry: {
    ridsForDevices: async () => new Map([["dv_member", 9]]),
  },
}));

// `replaceBindings` calls these only after the INSERT; stubbed so the transaction body completes.
jest.mock("@/lib/kv-cache-manager", () => ({
  buildSubscriptionRegistry: async () => {},
}));

import { replaceBindings } from "../create";
import { Point } from "@/lib/ids";
import {
  ensureHelperBindings,
  BLEND_POINTS,
} from "@/lib/battery-provenance/register";

const POINT_UID = "018f0000-0000-7000-8000-0000000000aa";

const inserts: { table: string; values: any }[] = [];

/** Records inserts; every read resolves empty; delete/update are no-ops. */
function makeFakeDb(pointRows: unknown[]) {
  const insertChain = (table: any) => {
    const chain: any = {
      values: (v: unknown) => {
        inserts.push({
          table: table[Symbol.for("drizzle:Name")],
          values: Array.isArray(v) ? v : [v],
        });
        return chain;
      },
      onConflictDoNothing: () => chain,
      returning: () => Promise.resolve([]),
      then: (res: any) => Promise.resolve([]).then(res),
    };
    return chain;
  };
  const readChain = (rows: unknown[]): any => {
    const chain: any = {
      from: () => chain,
      // slice 1b: the point read is now `points ⋈ devices`.
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (res: any) => Promise.resolve(rows).then(res),
    };
    return chain;
  };
  const writeChain = (): any => {
    const chain: any = {
      set: () => chain,
      where: () => Promise.resolve(),
      then: (res: any) => Promise.resolve().then(res),
    };
    return chain;
  };
  const db: any = {
    // The only projecting read in `replaceBindings` before the tx is the point_info lookup.
    select: () => readChain(pointRows),
    insert: insertChain,
    delete: () => ({ where: () => Promise.resolve() }),
    update: writeChain,
    transaction: async (fn: any) =>
      fn({
        select: () => readChain([]),
        insert: insertChain,
        delete: () => ({ where: () => Promise.resolve() }),
        update: writeChain,
      }),
  };
  return db;
}

beforeEach(() => {
  inserts.length = 0;
});

describe("area_bindings writers populate point_uid", () => {
  it("replaceBindings carries the uuid off the point_info row it already read", async () => {
    mockDb = makeFakeDb([
      {
        systemId: 9,
        index: 3,
        pointUid: POINT_UID,
        logicalPathStem: "bidi.grid",
        metricType: "power",
      },
    ]);

    await replaceBindings("area-a", [
      { role: "grid", metricType: "power", pointId: Point.encode(POINT_UID) },
    ]);

    const bindingInsert = inserts.find((i) => i.table === "area_bindings");
    expect(bindingInsert).toBeDefined();
    expect(bindingInsert!.values).toHaveLength(1);
    // The identity, not just "some uuid": it must be the one off the `point_info` row it read.
    expect(bindingInsert!.values[0]).toMatchObject({ pointUid: POINT_UID });
    // …and the retired int pair must not be named at all (migration 0048 drops both columns).
    expect(bindingInsert!.values[0]).not.toHaveProperty("pointSystemId");
    expect(bindingInsert!.values[0]).not.toHaveProperty("pointId");
  });

  it("ensureHelperBindings carries the uuids returned by ensureBatteryProvenancePoints", async () => {
    mockDb = makeFakeDb([]);

    // Keyed off the real spec list so a change to BLEND_POINTS cannot silently empty this test.
    const pointUids = Object.fromEntries(
      BLEND_POINTS.map((p, i) => [
        p.metricType,
        `018f0000-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`,
      ]),
    );

    await ensureHelperBindings("area-a", pointUids);

    const bindingInsert = inserts.find((i) => i.table === "area_bindings");
    expect(bindingInsert).toBeDefined();
    expect(bindingInsert!.values.length).toBeGreaterThan(0);
    for (const row of bindingInsert!.values) {
      // A helper binding with no uuid is the exact shape that made battery-provenance drop its own
      // blend points — the loader reads `point_uid` and treats NULL as "no data".
      expect(typeof row.pointUid).toBe("string");
      expect(row.pointUid).toBeTruthy();
      expect(row).not.toHaveProperty("pointSystemId");
      expect(row).not.toHaveProperty("pointId");
    }
  });
});

/**
 * The AMBIENT carve-out on `replaceBindings`' membership check.
 *
 * Membership is the firewall for an OWNED device: binding a point you can merely read would publish
 * someone else's readings into an area you control. For an OWNERLESS device it is not a firewall at
 * all, it is an unsatisfiable condition — `assertDevicesRehomable` refuses to place an ownerless
 * device in ANY area (422, admins included), so it can never become a member, and a binding is the
 * only way an area can name it. That is what the OpenElectricity NEM regions are: public, ambient,
 * consumed by every area in their state and contained by none.
 *
 * Pinned in BOTH directions, because the value of the exception is entirely in how narrow it is.
 */
describe("replaceBindings: ambient (ownerless) points may be bound without membership", () => {
  const AMBIENT_UID = "018f0000-0000-7000-8000-0000000000bb";

  it("ACCEPTS an ownerless point whose device is not a member", async () => {
    // systemId 77 is NOT in the mocked member set (9), and ownerUserId is null → ambient.
    mockDb = makeFakeDb([
      {
        systemId: 77,
        pointUid: AMBIENT_UID,
        logicalPathStem: "grid.price",
        metricType: "rate",
        ownerUserId: null,
      },
    ]);

    await replaceBindings("area-a", [
      { role: "grid", metricType: "rate", pointId: Point.encode(AMBIENT_UID) },
    ]);

    const bindingInsert = inserts.find((i) => i.table === "area_bindings");
    expect(bindingInsert).toBeDefined();
    expect(bindingInsert!.values[0]).toMatchObject({ pointUid: AMBIENT_UID });
  });

  it("still REFUSES a non-member point that has an owner — the firewall is untouched", async () => {
    mockDb = makeFakeDb([
      {
        systemId: 77,
        pointUid: AMBIENT_UID,
        logicalPathStem: "bidi.grid",
        metricType: "power",
        ownerUserId: "user_someone_else",
      },
    ]);

    await expect(
      replaceBindings("area-a", [
        {
          role: "grid",
          metricType: "power",
          pointId: Point.encode(AMBIENT_UID),
        },
      ]),
    ).rejects.toThrow(/not a member of this area/);
    expect(inserts.find((i) => i.table === "area_bindings")).toBeUndefined();
  });

  it("FAILS CLOSED when the projection omits ownerUserId", async () => {
    // Not a hypothetical contract: the carve-out reads a column this query must select. If a
    // refactor drops it, `undefined` must refuse rather than read as ambient — otherwise the
    // membership firewall silently stops applying to EVERY point, owned ones included.
    mockDb = makeFakeDb([
      {
        systemId: 77,
        pointUid: AMBIENT_UID,
        logicalPathStem: "grid.price",
        metricType: "rate",
      },
    ]);

    await expect(
      replaceBindings("area-a", [
        {
          role: "grid",
          metricType: "rate",
          pointId: Point.encode(AMBIENT_UID),
        },
      ]),
    ).rejects.toThrow(/not a member of this area/);
  });
});
