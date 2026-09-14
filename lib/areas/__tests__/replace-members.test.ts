/**
 * The membership DIFF behind `PUT /api/v4/areas/{id}/members`.
 *
 * 🛑 Why this exists rather than leaning on the live smoke run: a wrong removal set is SILENT in both
 * directions. Under-remove and a ghost member survives; over-remove and bindings that should have
 * stayed are gone — neither raises, and a status-and-payload assertion over the endpoint can pass
 * either way if the fixture happens not to distinguish them. `scripts/utils/v4-surface-smoke.ts` drives
 * the proving case for real (two members, a binding on EACH, remove one). This pins the decision itself:
 * WHICH members are treated as departing, in isolation from any particular data.
 *
 * The db is a recorder, not a query engine, so these assert the operations issued — which table, which
 * device, in which order — and deliberately not the rendered SQL (the live run covers that).
 *
 * 🛑 Stage 4 of the device→0..1-area change rewrote what "remove" MEANS here. Membership is
 * `devices.area_id`, so a departing member is an UPDATE to NULL — it becomes ambient, not deleted —
 * and a member that joins is an UPDATE to this area, which takes it out of whatever area it was in.
 * The `area_members` delete/upsert pair is gone, and with it `ordinal`: a pure reorder is now
 * genuinely a no-op rather than "a real edit".
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

let currentMembers: string[] = [];
let helperRows: { id: string }[] = [];
const ops: { op: string; table: string; values?: unknown }[] = [];

jest.mock("@/lib/areas/members", () => ({
  getAreaMemberDeviceIds: jest.fn(async () => currentMembers),
  // The real `setDeviceArea`'s only job is `UPDATE devices SET area_id`, which the recorder below
  // captures the same way it captures every other op — so it is recorded, not stubbed away.
  setDeviceArea: jest.fn(async (_db: unknown, id: string, areaId: unknown) => {
    ops.push({
      op: "set-area",
      table: "devices",
      values: { deviceId: id, areaId },
    });
  }),
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => fakeDb,
}));
jest.mock("@/lib/kv-cache-manager", () => ({
  buildSubscriptionRegistry: jest.fn(),
}));

import { areaBindings, devices } from "@/lib/db/planetscale/schema";
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
    : table === devices
      ? "devices"
      : "«unexpected table»";

const tx = {
  select: () => ({ from: () => ({ where: () => "«subquery»" }) }),
  delete: (table: unknown) => ({
    where: async () => {
      ops.push({ op: "delete", table: nameOf(table) });
    },
  }),
  update: (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        ops.push({ op: "update", table: nameOf(table), values: values.areaId });
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
  it("ACCEPTS an empty membership — a zero-device area is first-class now", async () => {
    // The old rule ("an area must have at least one member") is retired with the area-of-one: it is
    // what made "hide areas-of-one" a render-time convention instead of the structural "hide areas
    // with zero devices". Emptying an area orphans its members; it does not delete them.
    await replaceMembers("area-a", []);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "set-area devices",
      "delete area_bindings",
      "set-area devices",
    ]);
    expect(ops.filter((o) => o.op === "set-area").map((o) => o.values)).toEqual(
      [
        { deviceId: A, areaId: null },
        { deviceId: B, areaId: null },
      ],
    );
  });

  it("refuses a duplicate — the wire is a set, stated as an array", async () => {
    await expect(replaceMembers("area-a", [A, B, A])).rejects.toBeInstanceOf(
      AreaValidationError,
    );
    expect(ops).toHaveLength(0);
  });

  it("orphans exactly the omitted member, bindings FIRST, then the area edge", async () => {
    await replaceMembers("area-a", [A]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "set-area devices",
      "update devices",
    ]);
    // The departing member becomes AMBIENT, not deleted.
    expect(ops[1].values).toEqual({ deviceId: B, areaId: null });
  });

  it("a pure reorder is now a genuine no-op on the departing set", async () => {
    await replaceMembers("area-a", [B, A]);
    expect(ops.filter((o) => o.op === "delete")).toHaveLength(0);
    // 🛑 …and it no longer reorders anything. The array index used to become `area_members.ordinal`;
    // with one area per device there is no membership row to carry one, and intra-area order comes
    // from `getAreaMemberDeviceIds`' `(helper-last, rid)` sort. All that remains is one UPDATE
    // re-asserting the area both members are already in.
    expect(ops).toEqual([{ op: "update", table: "devices", values: "area-a" }]);
  });

  it("writes the WHOLE wanted set in one UPDATE, joiners and stayers alike", async () => {
    currentMembers = [A];
    await replaceMembers("area-a", [A, B]);
    // 🛑 B is MOVED here — it leaves whatever area it was in. That is why the route must run
    // `assertDevicesRehomable` first: read access alone used to be a sufficient firewall because
    // membership was additive, and it is not sufficient for a verb that removes.
    expect(ops).toEqual([{ op: "update", table: "devices", values: "area-a" }]);
  });

  it("🛑 never evicts a SERVER-MANAGED helper member that the caller omitted", async () => {
    // The hazard: a client reads `members`, filters to the real devices its picker shows, and PUTs the
    // result back. Without this rule that would delete the area's blend bindings and blank its
    // provenance card until the next daily recompute rebuilt them.
    currentMembers = [A, HELPER];
    helperRows = [{ id: uuid(3) }];
    await replaceMembers("area-a", [A]);
    expect(ops.filter((o) => o.op !== "update")).toHaveLength(0);
  });

  it("…and the exception is narrow: a REAL member omitted alongside a helper still goes", async () => {
    currentMembers = [A, B, HELPER];
    helperRows = [{ id: uuid(3) }];
    await replaceMembers("area-a", [A]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "set-area devices",
      "update devices",
    ]);
    expect(ops[1].values).toEqual({ deviceId: B, areaId: null });
  });
});
