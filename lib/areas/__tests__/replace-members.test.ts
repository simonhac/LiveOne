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
/** What `currentAreaOf` sees: where each device lives RIGHT NOW. */
let deviceRows: { id: string; areaId: string | null }[] = [];
const ops: { op: string; table: string; values?: unknown }[] = [];

jest.mock("@/lib/areas/members", () => ({
  getAreaMemberDeviceIds: jest.fn(async () => currentMembers),
  setDeviceArea: jest.fn(),
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

/**
 * `tx.select().from(devices).where(...)` is BOTH a sub-select (inside the binding delete) and a real
 * read (`currentAreaOf`, which asks where each incoming device lives now). It is awaitable so the
 * read resolves, and stringifies as a subquery for the delete.
 */
const tx = {
  select: () => ({
    from: (table: unknown) => ({
      where: () =>
        Object.assign(Promise.resolve(table === devices ? deviceRows : []), {
          toString: () => "«subquery»",
        }),
    }),
  }),
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
  deviceRows = [
    { id: uuid(1), areaId: "area-a" },
    { id: uuid(2), areaId: "area-a" },
  ];
});

describe("replaceMembers — the declarative full replace", () => {
  it("ACCEPTS an empty membership — a zero-device area is first-class now", async () => {
    // The old rule ("an area must have at least one member") is retired with the area-of-one: it is
    // what made "hide areas-of-one" a render-time convention instead of the structural "hide areas
    // with zero devices". Emptying an area orphans its members; it does not delete them.
    await replaceMembers("area-a", []);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "update devices",
      "delete area_bindings",
      "update devices",
    ]);
    // Both departures are a NULL, not a delete — the devices become ambient.
    expect(ops.filter((o) => o.op === "update").map((o) => o.values)).toEqual([
      null,
      null,
    ]);
  });

  it("refuses a duplicate — the wire is a set, stated as an array", async () => {
    await expect(replaceMembers("area-a", [A, B, A])).rejects.toBeInstanceOf(
      AreaValidationError,
    );
    expect(ops).toHaveLength(0);
  });

  it("orphans exactly the omitted member, bindings FIRST, then the area edge", async () => {
    const vacated = await replaceMembers("area-a", [A]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "update devices",
    ]);
    expect(ops[1].values).toBe(null); // B becomes AMBIENT, not deleted
    // A is already in area-a, so it is not rewritten and nothing was vacated.
    expect(vacated).toEqual([]);
  });

  it("a member already in this area is left completely alone", async () => {
    const vacated = await replaceMembers("area-a", [A, B]);
    expect(ops).toEqual([]);
    expect(vacated).toEqual([]);
  });

  it("🛑 a JOINING member is detached from the area it came FROM, bindings and all", async () => {
    // The defect this pins, found in review: the first cut wrote `area_id` for the incoming device
    // and stopped. `area_bindings` says nothing about membership, and the resolver treats bindings
    // as the OVERRIDE that SELECTS an area's points — so the source area went on serving a device it
    // no longer held, silently, with nothing to grep for.
    currentMembers = [A];
    deviceRows = [
      { id: uuid(1), areaId: "area-a" },
      { id: uuid(2), areaId: "area-elsewhere" },
    ];
    const vacated = await replaceMembers("area-a", [A, B]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings", // …in area-elsewhere, B's former home
      "update devices",
    ]);
    expect(ops[1].values).toBe("area-a");
    // 🛑 Returned so the ROUTE can refresh serving at both ends — the source area's KV subscription
    // registry and point-series cache still name this device's points.
    expect(vacated).toEqual(["area-elsewhere"]);
  });

  it("moves an AMBIENT device in without trying to detach it from anywhere", async () => {
    currentMembers = [A];
    deviceRows = [
      { id: uuid(1), areaId: "area-a" },
      { id: uuid(2), areaId: null },
    ];
    const vacated = await replaceMembers("area-a", [A, B]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual(["update devices"]);
    expect(vacated).toEqual([]);
  });

  it("🛑 never evicts a SERVER-MANAGED helper member that the caller omitted", async () => {
    // The hazard: a client reads `members`, filters to the real devices its picker shows, and PUTs the
    // result back. Without this rule that would delete the area's blend bindings and blank its
    // provenance card until the next daily recompute rebuilt them.
    currentMembers = [A, HELPER];
    helperRows = [{ id: uuid(3) }];
    deviceRows = [
      { id: uuid(1), areaId: "area-a" },
      { id: uuid(3), areaId: "area-a" },
    ];
    await replaceMembers("area-a", [A]);
    expect(ops).toEqual([]);
  });

  it("…and the exception is narrow: a REAL member omitted alongside a helper still goes", async () => {
    currentMembers = [A, B, HELPER];
    helperRows = [{ id: uuid(3) }];
    await replaceMembers("area-a", [A]);
    expect(ops.map((o) => `${o.op} ${o.table}`)).toEqual([
      "delete area_bindings",
      "update devices",
    ]);
    expect(ops[1].values).toBe(null);
  });
});
