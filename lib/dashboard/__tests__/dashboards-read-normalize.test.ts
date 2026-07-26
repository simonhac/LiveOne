import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// getDashboard's rowToDashboard read-normalizes a v3 descriptor's section.areaId to `ar_` regardless
// of what's stored — the lever that decouples the code deploy from the one-off descriptor migration
// (scripts/config-v4/rewrite-descriptor-area-refs.ts). Mock the drizzle select, table-aware, mirroring
// lib/__tests__/user-preferences.test.ts.
let dashboardRow: Record<string, unknown> | null;

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => Promise.resolve(dashboardRow ? [dashboardRow] : []);
    return builder;
  },
}));

import { getDashboard } from "../dashboards";
import { Area, Dashboard, newUuidV7 } from "@/lib/ids";

const DASH_UUID = "00000000-0000-7000-8000-000000000001";
const AREA_UUID_1 = newUuidV7();
const AREA_UUID_2 = newUuidV7();

beforeEach(() => {
  dashboardRow = {
    id: DASH_UUID,
    clerkUserId: "owner_1",
    displayName: "Test",
    alias: null,
    doc: null,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
});

describe("getDashboard — descriptor read-normalize", () => {
  it("encodes a pre-migration (raw-uuid) descriptor's section.areaId to ar_ on read", async () => {
    dashboardRow!.descriptor = {
      version: 3,
      sections: [
        { areaId: AREA_UUID_1, cards: [] },
        { areaId: AREA_UUID_2, cards: [] },
      ],
    };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dashboard?.descriptor.sections.map((s) => s.areaId)).toEqual([
      Area.encode(AREA_UUID_1),
      Area.encode(AREA_UUID_2),
    ]);
  });

  it("is a no-op on an already-migrated (ar_) descriptor", async () => {
    dashboardRow!.descriptor = {
      version: 3,
      sections: [{ areaId: Area.encode(AREA_UUID_1), cards: [] }],
    };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dashboard?.descriptor.sections[0].areaId).toBe(
      Area.encode(AREA_UUID_1),
    );
  });

  it("leaves a non-v3 descriptor untouched", async () => {
    dashboardRow!.descriptor = { version: 2, cards: [] };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dashboard?.descriptor).toEqual({ version: 2, cards: [] });
  });
});
