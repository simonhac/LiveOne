import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// user-preferences talks to Postgres directly (users/systems/user_systems) and to two collaborators
// (the dashboard store + the systems cache). Mock the db with a tiny table-aware chainable fake and the
// collaborators as modules, so we can drive the default_dashboard_id branching — especially the lazy
// migration from the legacy default_system_id — without a real database.

let usersRow: Record<string, unknown> | null;
let systemRow: Record<string, unknown> | null;
const updates: Array<Record<string, unknown>> = [];

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => {
    let table: unknown = null;
    let mode: "select" | "update" | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = () => ((mode = "select"), builder);
    builder.from = (t: unknown) => ((table = t), builder);
    builder.update = (t: unknown) => ((mode = "update"), (table = t), builder);
    builder.set = (payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    };
    builder.where = () =>
      mode === "update" ? Promise.resolve(undefined) : builder;
    builder.limit = () => {
      const { users, systems, userSystems } = jest.requireActual<
        typeof import("@/lib/db/planetscale/schema")
      >("@/lib/db/planetscale/schema");
      if (table === users) return Promise.resolve(usersRow ? [usersRow] : []);
      if (table === systems)
        return Promise.resolve(systemRow ? [systemRow] : []);
      if (table === userSystems) return Promise.resolve([]); // owner match covers access
      return Promise.resolve([]);
    };
    return builder;
  },
}));

const mockGetDashboardById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockGetOrCreate = jest.fn<(...a: unknown[]) => Promise<number>>();
jest.mock("@/lib/dashboard/store", () => ({
  getDashboardById: (...a: unknown[]) => mockGetDashboardById(...a),
  getOrCreateDefaultDashboardId: (...a: unknown[]) => mockGetOrCreate(...a),
}));

const mockGetSystem = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock("@/lib/systems-manager", () => ({
  SystemsManager: { getInstance: () => ({ getSystem: mockGetSystem }) },
}));

import {
  getValidDefaultDashboardId,
  getValidDefaultSystemId,
} from "@/lib/user-preferences";

const USER = "u1";

beforeEach(() => {
  updates.length = 0;
  jest.clearAllMocks();
  // Default: an active system owned by USER (so isSystemValidForDefault passes via owner match).
  systemRow = { id: 5, status: "active", ownerClerkUserId: USER };
  usersRow = {
    clerkUserId: USER,
    defaultSystemId: null,
    defaultDashboardId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  mockGetSystem.mockResolvedValue({ id: 5, vendorType: "selectronic" });
});

describe("getValidDefaultDashboardId", () => {
  it("Path A: resolves an already-set default_dashboard_id (no write)", async () => {
    usersRow!.defaultDashboardId = 77;
    mockGetDashboardById.mockResolvedValue({
      id: 77,
      systemId: 5,
      areaId: null,
    });
    const out = await getValidDefaultDashboardId(USER);
    expect(out).toEqual({ dashboardId: 77, systemId: 5 });
    expect(updates).toHaveLength(0); // valid → no clear, no re-write
  });

  it("Path B: lazily migrates a legacy default_system_id → materializes + adopts a dashboard", async () => {
    usersRow!.defaultSystemId = 5;
    mockGetOrCreate.mockResolvedValue(77);
    const out = await getValidDefaultDashboardId(USER);
    expect(out).toEqual({ dashboardId: 77, systemId: 5 });
    expect(mockGetOrCreate).toHaveBeenCalledWith(USER, 5, "selectronic");
    // Adopted: both columns written (forward id + legacy kept in sync).
    expect(updates).toContainEqual(
      expect.objectContaining({ defaultDashboardId: 77, defaultSystemId: 5 }),
    );
  });

  it("auto-clears BOTH columns when the default's system is no longer valid", async () => {
    usersRow!.defaultDashboardId = 77;
    mockGetDashboardById.mockResolvedValue({
      id: 77,
      systemId: 5,
      areaId: null,
    });
    systemRow = { id: 5, status: "removed", ownerClerkUserId: USER }; // invalid
    const out = await getValidDefaultDashboardId(USER);
    expect(out).toBeNull();
    expect(updates).toContainEqual(
      expect.objectContaining({
        defaultDashboardId: null,
        defaultSystemId: null,
      }),
    );
  });

  it("returns null when no default is set at all", async () => {
    const out = await getValidDefaultDashboardId(USER);
    expect(out).toBeNull();
    expect(updates).toHaveLength(0);
  });
});

describe("getValidDefaultSystemId (back-compat wrapper)", () => {
  it("returns just the systemId from the resolved default dashboard", async () => {
    usersRow!.defaultDashboardId = 77;
    mockGetDashboardById.mockResolvedValue({
      id: 77,
      systemId: 5,
      areaId: null,
    });
    expect(await getValidDefaultSystemId(USER)).toBe(5);
  });
});
