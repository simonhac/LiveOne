import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Area, Device, Dashboard } from "@/lib/ids";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@clerk/nextjs/server", () => ({ clerkClient: jest.fn() }));
jest.mock("@/lib/derivations/scope", () => ({
  listReadableDerivations: jest.fn(),
}));
jest.mock("@/lib/dashboard/composition", () => ({
  dashboardAreaUuids: jest.fn(),
}));
jest.mock("@/lib/dashboard/access", () => ({ allowedSystemIds: jest.fn() }));
jest.mock("@/lib/dashboard/v4", () => ({ isDashboardV4: () => false }));
jest.mock("@/lib/readings/dao", () => ({
  ReadingsDao: { agg1dSpanForDevice: jest.fn() },
}));
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { clerkClient } from "@clerk/nextjs/server";
import { listReadableDerivations } from "@/lib/derivations/scope";
import { dashboardAreaUuids } from "@/lib/dashboard/composition";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { ReadingsDao } from "@/lib/readings/dao";
import { readTreeInventory } from "../read";

const area = Area.toUuid(Area.generate());
const device = Device.toUuid(Device.generate());
const dash = Dashboard.toUuid(Dashboard.generate());
const queries: { table: string; fields: string[]; condition?: SQL }[] = [];
let rows: Record<string, unknown[]>;
const user = {
  id: "owner",
  firstName: "Owner",
  lastName: null,
  username: "owner",
  emailAddresses: [],
};
const getUserList = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getUser = jest.fn<(...args: unknown[]) => Promise<unknown>>();
beforeEach(() => {
  jest.clearAllMocks();
  queries.length = 0;
  rows = {
    areas: [
      {
        id: area,
        name: "Empty archived area",
        status: "archived",
        ownerId: "owner",
      },
    ],
    devices: [
      {
        id: device,
        handle: 9,
        name: "Removed device",
        vendor: "amber",
        status: "removed",
        ownerId: "owner",
        areaId: null,
      },
    ],
    dashboards: [{ id: dash, name: "Shared view", ownerId: "owner", doc: {} }],
    dashboard_grants: [{ dashboardId: dash, userId: "reader", role: "viewer" }],
    share_tokens: [{ dashboardId: dash, count: 1 }],
    area_calendar_tokens: [{ areaId: area, count: 1 }],
  };
  jest.mocked(requirePlanetscaleDb).mockReturnValue({
    select: (selection: Record<string, unknown>) => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const query = {
          table: getTableName(table),
          fields: Object.keys(selection),
          condition: undefined as SQL | undefined,
        };
        queries.push(query);
        const chain = {
          where: (condition?: SQL) => {
            query.condition = condition;
            return chain;
          },
          groupBy: () => chain,
          then: (
            resolve: (value: unknown[]) => unknown,
            reject: (e: unknown) => unknown,
          ) => Promise.resolve(rows[query.table] ?? []).then(resolve, reject),
        };
        return chain;
      },
    }),
  } as never);
  jest
    .mocked(clerkClient)
    .mockResolvedValue({ users: { getUserList, getUser } } as never);
  getUserList.mockResolvedValue({
    data: [user, { ...user, id: "empty-user", firstName: "No objects" }],
    totalCount: 2,
  });
  getUser.mockResolvedValue(user);
  jest.mocked(listReadableDerivations).mockResolvedValue([]);
  jest.mocked(dashboardAreaUuids).mockReturnValue([area]);
  jest.mocked(allowedSystemIds).mockResolvedValue([9]);
  jest.mocked(ReadingsDao.agg1dSpanForDevice).mockResolvedValue(null);
});
const sqlFor = (table: string) =>
  new PgDialect().sqlToQuery(
    queries.find((q) => q.table === table)!.condition!,
  );

describe("inventory read scope", () => {
  it("filters base objects by owner, retains statuses and skips sharing queries by default", async () => {
    const result = await readTreeInventory("owner", false, false);
    for (const table of ["areas", "devices", "dashboards"]) {
      expect(sqlFor(table).params).toEqual(["owner"]);
      expect(sqlFor(table).sql).toContain("owner_user_id");
    }
    expect(listReadableDerivations).toHaveBeenCalledWith("owner", false);
    expect(
      queries.some(
        (q) =>
          q.table === "share_tokens" ||
          q.table === "dashboard_grants" ||
          q.table === "area_calendar_tokens",
      ),
    ).toBe(false);
    expect(result.sharing).toBeUndefined();
    expect(result.areas[0].status).toBe("archived");
    expect(result.devices[0].status).toBe("removed");
    expect(result.devices[0].areaId).toBeNull();
    expect(getUserList).not.toHaveBeenCalled();
  });
  it("includes users without devices and permits fleet reads only through the passed scope", async () => {
    const result = await readTreeInventory("admin", true, false);
    expect(result.users.map((u) => u.id)).toContain("empty-user");
    for (const table of ["areas", "devices", "dashboards"])
      expect(queries.find((q) => q.table === table)?.condition).toBeUndefined();
    expect(listReadableDerivations).toHaveBeenCalledWith("admin", true);
  });
  it("uses effective sharing scope and selects no secrets, counting only active links", async () => {
    const result = await readTreeInventory("owner", false, true);
    expect(allowedSystemIds).toHaveBeenCalledWith({ doc: {} });
    expect(result.sharing?.dashboards[0]).toMatchObject({
      deviceIds: [Device.encode(device)],
      recipients: [{ userId: "reader", role: "viewer" }],
      activeLinks: 1,
    });
    for (const table of ["share_tokens", "area_calendar_tokens"]) {
      expect(queries.find((q) => q.table === table)?.fields).not.toContain(
        "token",
      );
      const sql = sqlFor(table);
      expect(sql.sql).toContain('"revoked_at" is null');
      expect(sql.sql).toContain('"expires_at" is null');
      expect(sql.sql).toContain('"expires_at" >');
    }
  });
});
