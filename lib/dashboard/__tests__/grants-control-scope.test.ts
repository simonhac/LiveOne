/**
 * `controllableDeviceScopeForUser` — which devices a `control` grant delegates.
 *
 * 🛑 The dashboard-OWNER filter is the case that matters: commands run on the device owner's vendor
 * credentials, so a dashboard that merely SHOWS someone else's (or an ownerless) device must not
 * hand out control of it.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Dashboard } from "@/lib/ids";

const DASH_A = Dashboard.generate();
const DASH_B = Dashboard.generate();

let rows: { dashboardId: string }[] = [];
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    select: () => ({ from: () => ({ where: async () => rows }) }),
  }),
}));
jest.mock("@/lib/dashboard/dashboards", () => ({ getDashboard: jest.fn() }));
jest.mock("@/lib/dashboard/access", () => ({ allowedSystemIds: jest.fn() }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn() },
}));

import { controllableDeviceScopeForUser } from "@/lib/dashboard/grants";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/** Device owners: 10 the generator (simon), 11 the car (simon), 12 someone else's, 13 ownerless. */
const OWNERS: Record<number, string | null> = {
  10: "user_simon",
  11: "user_simon",
  12: "user_other",
  13: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  rows = [{ dashboardId: Dashboard.toUuid(DASH_A) }];
  jest.mocked(getDashboard).mockImplementation(
    async (id: string) =>
      ({
        id,
        ownerClerkUserId: id === DASH_A ? "user_simon" : "user_other",
        doc: { id },
      }) as never,
  );
  jest
    .mocked(allowedSystemIds)
    .mockImplementation(async ({ doc }) =>
      (doc as { id: string }).id === DASH_A ? [10, 11, 12, 13, 7] : [12],
    );
  jest
    .mocked(DeviceConfigRegistry.deviceByHandle)
    .mockImplementation(async (h: number) =>
      h in OWNERS ? ({ id: h, ownerClerkUserId: OWNERS[h] } as never) : null,
    );
});

describe("controllableDeviceScopeForUser", () => {
  it("delegates only the shown devices the DASHBOARD OWNER owns", async () => {
    // 12 is someone else's, 13 is ownerless, 7 is an area handle (no device) — none delegated.
    expect([...(await controllableDeviceScopeForUser("user_k"))]).toEqual([
      10, 11,
    ]);
  });

  it("unions across dashboards, each filtered by ITS OWN owner", async () => {
    rows = [
      { dashboardId: Dashboard.toUuid(DASH_A) },
      { dashboardId: Dashboard.toUuid(DASH_B) },
    ];
    expect(
      [...(await controllableDeviceScopeForUser("user_k"))].sort(),
    ).toEqual([10, 11, 12]);
  });

  it("no control grants → nothing", async () => {
    rows = [];
    expect((await controllableDeviceScopeForUser("user_k")).size).toBe(0);
    expect(getDashboard).not.toHaveBeenCalled();
  });
});
