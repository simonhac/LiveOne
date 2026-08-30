/**
 * The membership DIFF behind `PUT /api/v4/areas/{id}/members`.
 *
 * 🛑 Why this exists rather than leaning on the live smoke run: a wrong removal set is SILENT in both
 * directions. Under-delete and a ghost member survives; over-delete and bindings that should have
 * stayed are gone — neither raises, and a status-and-payload assertion over the endpoint can pass
 * either way if the fixture happens not to distinguish them. `scripts/utils/v4-surface-smoke.ts` drives
 * the proving case for real (two members, a binding on EACH, remove one). This pins the decision itself:
 * WHICH members are treated as departing, in isolation from any particular data.
 *
 * The db is a recorder, not a query engine, so these assert the operations issued — which table, which
 * device, in which order — and deliberately not the rendered SQL (the live run covers that).
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

let currentMembers: string[] = [];
let helperRows: { id: string }[] = [];
const ops: { op: string; table: string; values?: unknown }[] = [];

jest.mock("@/lib/areas/members", () => ({
  getAreaMemberDeviceIds: jest.fn(async () => currentMembers),
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => fakeDb,
}));
jest.mock("@/lib/kv-cache-manager", () => ({
  buildSubscriptionRegistry: jest.fn(),
}));

import { areaBindings, areaMembers } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";
import { replaceMembers, AreaValidationError } from "../create";

/**
 * Identify the target table by IDENTITY against the imported schema objects, not by reading a name off
 * the drizzle table (its name lives behind a private symbol). Identity is the stronger assertion
 * anyway: it fails if the DAO is re-pointed at a different table, which a name-shaped string built from
 * the same object could not.
 */
const nameOf = (table: unknown): string =>
  table === areaBindings
    ? "area_bindings"
    : table === areaMembers
      ? "area_members"
      : "«unexpected table»";

const tx = {
  select: () => ({ from: () => ({ where: () => "«subquery»" }) }),
  delete: (table: unknown) => ({
    where: async () => {
      ops.push({ op: "delete", table: nameOf(table) });
    },
  }),
  insert: (table: unknown) => ({
    values: (values: unknown) => ({
      onConflictDoUpdate: async () => {
        ops.push({ op: "upsert", table: nameOf(table), values });
      },
    }),
  }),
};
const fakeDb = {
  select: () => ({ from: () => ({ where: async () => helperRows }) }),
  transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
};

const uuid = (n: number) => `018f0000-0000-7000-8000-00000000000${n}`;
const A = Device.encode(uuid(1));
const B = Device.encode(uuid(2));
const HELPER = Device.encode(uuid(3));

beforeEach(() => {
  ops.length = 0;
  currentMembers = [A, B];
  helperRows = [];
});

describe("replaceMembers — the declarative full replace", () => {
  it("refuses an empty membership (an area of zero members has no point set)", async () => {
    await expect(replaceMembers("area-a", [])).rejects.toBeInstanceOf(
      AreaValidationError,
    );
    expect(ops).toHaveLength(0);
  });

  it("refuses a duplicate — `[a, b, a]` states two ordinals for one member", async () => {
    await expect(replaceMembers("area-a", [A, B, A])).rejects.toBeInstanceOf(
      AreaValidationError,
    );
    expect(ops).toHaveLength(0);
  });

  it("removes exactly the omitted member, bindings FIRST, then the membership row", async () => {
    await replaceMembers("area-a", [A]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "delete area_members",
      "upsert area_members",
    ]);
  });

  it("removes NOTHING when the membership is merely reordered", async () => {
    await replaceMembers("area-a", [B, A]);
    expect(ops.filter((o) => o.op === "delete")).toHaveLength(0);
    // …but the reorder is still APPLIED: the array index is the ordinal.
    expect(ops[0].values).toEqual([
      { areaId: "area-a", deviceId: uuid(2), ordinal: 0 },
      { areaId: "area-a", deviceId: uuid(1), ordinal: 1 },
    ]);
  });

  it("upserts every WANTED member, not merely the new ones (a stayer may be moving ordinal)", async () => {
    currentMembers = [A];
    await replaceMembers("area-a", [A, B]);
    expect(ops).toEqual([
      {
        op: "upsert",
        table: "area_members",
        values: [
          { areaId: "area-a", deviceId: uuid(1), ordinal: 0 },
          { areaId: "area-a", deviceId: uuid(2), ordinal: 1 },
        ],
      },
    ]);
  });

  it("🛑 never evicts a SERVER-MANAGED helper member that the caller omitted", async () => {
    // The hazard: a client reads `members`, filters to the real devices its picker shows, and PUTs the
    // result back. Without this rule that would delete the area's blend bindings and blank its
    // provenance card until the next daily recompute rebuilt them.
    currentMembers = [A, HELPER];
    helperRows = [{ id: uuid(3) }];
    await replaceMembers("area-a", [A]);
    expect(ops.filter((o) => o.op === "delete")).toHaveLength(0);
  });

  it("…and the exception is narrow: a REAL member omitted alongside a helper still goes", async () => {
    currentMembers = [A, B, HELPER];
    helperRows = [{ id: uuid(3) }];
    await replaceMembers("area-a", [A]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "delete area_members",
      "upsert area_members",
    ]);
  });
});
