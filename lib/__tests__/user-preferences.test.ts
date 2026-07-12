import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// user-preferences reads/writes the `users` table and delegates dashboard existence/ownership to
// getDashboard. Mock the db with a tiny table-aware chainable fake + getDashboard as a module, so the
// default_dashboard_id branching is driven without a real database.

let usersRow: Record<string, unknown> | null;
const updates: Array<Record<string, unknown>> = [];

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => {
    let table: unknown = null;
    let mode: "select" | "update" | "insert" | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = () => ((mode = "select"), builder);
    builder.from = (t: unknown) => ((table = t), builder);
    builder.update = (t: unknown) => ((mode = "update"), (table = t), builder);
    builder.insert = (t: unknown) => ((mode = "insert"), (table = t), builder);
    builder.values = () => builder;
    builder.onConflictDoNothing = () => Promise.resolve(undefined);
    builder.set = (payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    };
    builder.where = () =>
      mode === "update" ? Promise.resolve(undefined) : builder;
    builder.limit = () => {
      const { users } = jest.requireActual<
        typeof import("@/lib/db/planetscale/schema")
      >("@/lib/db/planetscale/schema");
      if (table === users) return Promise.resolve(usersRow ? [usersRow] : []);
      return Promise.resolve([]);
    };
    return builder;
  },
}));

const mockGetDashboard = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock("@/lib/dashboard/dashboards", () => ({
  getDashboard: (...a: unknown[]) => mockGetDashboard(...a),
}));

import {
  resolveDefaultDashboardRoute,
  setDefaultDashboardById,
  clearDefaultDashboard,
} from "@/lib/user-preferences";

const USER = "u1";

beforeEach(() => {
  updates.length = 0;
  jest.clearAllMocks();
  usersRow = {
    clerkUserId: USER,
    defaultDashboardId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
});

describe("resolveDefaultDashboardRoute (landing redirect target)", () => {
  it("a set default → /dashboard/id/{id} (no write)", async () => {
    usersRow!.defaultDashboardId = 88;
    mockGetDashboard.mockResolvedValue({
      id: 88,
      ownerClerkUserId: USER,
      displayName: "Home",
    });
    expect(await resolveDefaultDashboardRoute(USER)).toBe("/dashboard/id/88");
    expect(updates).toHaveLength(0);
  });

  it("no default → null (no write)", async () => {
    expect(await resolveDefaultDashboardRoute(USER)).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("auto-clears a stale pointer whose dashboard has vanished", async () => {
    usersRow!.defaultDashboardId = 77;
    mockGetDashboard.mockResolvedValue(null);
    expect(await resolveDefaultDashboardRoute(USER)).toBeNull();
    expect(updates).toContainEqual(
      expect.objectContaining({ defaultDashboardId: null }),
    );
  });
});

describe("setDefaultDashboardById (owner-only)", () => {
  it("owner's dashboard → writes default_dashboard_id", async () => {
    mockGetDashboard.mockResolvedValue({
      id: 90,
      ownerClerkUserId: USER,
      displayName: "My Home",
    });
    const res = await setDefaultDashboardById(USER, 90);
    expect(res.success).toBe(true);
    expect(updates).toContainEqual(
      expect.objectContaining({ defaultDashboardId: 90 }),
    );
  });

  it("rejects another user's dashboard (no write)", async () => {
    mockGetDashboard.mockResolvedValue({
      id: 90,
      ownerClerkUserId: "someone-else",
      displayName: "Theirs",
    });
    const res = await setDefaultDashboardById(USER, 90);
    expect(res.success).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("404-sentinels a missing dashboard", async () => {
    mockGetDashboard.mockResolvedValue(null);
    const res = await setDefaultDashboardById(USER, 91);
    expect(res).toEqual({ success: false, error: "not_found" });
  });
});

describe("clearDefaultDashboard", () => {
  it("nulls default_dashboard_id", async () => {
    usersRow!.defaultDashboardId = 90;
    const res = await clearDefaultDashboard(USER);
    expect(res.success).toBe(true);
    expect(updates).toContainEqual(
      expect.objectContaining({ defaultDashboardId: null }),
    );
  });
});
