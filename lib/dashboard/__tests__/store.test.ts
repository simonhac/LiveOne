import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// getOrCreateDefaultDashboardId queries + inserts via requirePlanetscaleDb and resolves the area via
// getAreaForSystem. Mock both so we can drive the concurrent-insert race deterministically (no DB).
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(),
}));
jest.mock("@/lib/areas/resolve", () => ({
  getAreaForSystem: jest.fn(),
}));
// The default descriptor is built server-side from capabilities; stub it (no point/DB layer needed here).
jest.mock("@/lib/capabilities/server", () => ({
  buildAreaStrategyForHandle: jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ version: 3, sections: [] }),
}));

import { getOrCreateDefaultDashboardId } from "@/lib/dashboard/store";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { getAreaForSystem } from "@/lib/areas/resolve";

const mockRequireDb = jest.mocked(requirePlanetscaleDb);
const mockGetArea = jest.mocked(getAreaForSystem);

// A minimal chainable drizzle stand-in: select().from().where().limit() resolves to the next queued
// rows array; insert().values().returning() resolves to [{id}] unless told to throw a 23505.
let selectQueue: Array<Array<{ id: number }>> = [];
let insertOutcome: { kind: "ok"; id: number } | { kind: "conflict" };

function makeDb() {
  const selectChain = (rows: Array<{ id: number }>) => ({
    from: () => selectChain(rows),
    where: () => selectChain(rows),
    limit: () => Promise.resolve(rows),
  });
  return {
    select: () => selectChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: () => ({
        returning: () =>
          insertOutcome.kind === "conflict"
            ? Promise.reject({ code: "23505" })
            : Promise.resolve([{ id: insertOutcome.id }]),
      }),
    }),
  };
}

beforeEach(() => {
  selectQueue = [];
  insertOutcome = { kind: "ok", id: 0 };
  mockRequireDb.mockReturnValue(
    makeDb() as unknown as ReturnType<typeof requirePlanetscaleDb>,
  );
  mockGetArea.mockResolvedValue(null);
});

describe("getOrCreateDefaultDashboardId", () => {
  it("returns the existing dashboard id without inserting", async () => {
    selectQueue = [[{ id: 42 }]]; // getDashboardIdForUserSystem finds a row
    const id = await getOrCreateDefaultDashboardId("user_a", 1);
    expect(id).toBe(42);
  });

  it("inserts a default row when none exists", async () => {
    selectQueue = [[]]; // no existing row
    insertOutcome = { kind: "ok", id: 999 };
    const id = await getOrCreateDefaultDashboardId("user_a", 1);
    expect(id).toBe(999);
  });

  it("survives the concurrent-insert race: on a 23505 it re-selects the winner's row", async () => {
    // 1st select: none. insert: loses the race (unique violation). 2nd select: the winner's row.
    selectQueue = [[], [{ id: 777 }]];
    insertOutcome = { kind: "conflict" };
    const id = await getOrCreateDefaultDashboardId("user_a", 1);
    expect(id).toBe(777);
  });

  it("re-throws a 23505 if the row still isn't there after re-select", async () => {
    selectQueue = [[], []];
    insertOutcome = { kind: "conflict" };
    await expect(
      getOrCreateDefaultDashboardId("user_a", 1),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
