import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// config-v4 Phase 14: `rowToDashboard` NO LONGER read-normalizes `section.areaId`. It used to run
// `encodeDescriptorAreaRefs` on every read so the code deploy did not have to be simultaneous with a
// one-off descriptor rewrite. Stored data is now 100% `ar_` (measured on prod `sydney` and
// `liveone-dev`, 16/16 refs each), so the normalize was a no-op that also masked any writer able to
// re-dirty the column.
//
// This suite is deliberately kept (rather than deleted with the behaviour) because the property that
// matters INVERTED and is now worth asserting: the descriptor is handed out VERBATIM, so a raw-uuid
// row would surface as a raw uuid rather than being silently laundered. That is the whole safety
// argument for `PATCH /api/dashboards/{id}`'s new 400 — if this ever starts laundering again, the
// gate downstream stops being load-bearing and the column can re-dirty undetected.
//
// Mock the drizzle select, table-aware, mirroring lib/__tests__/user-preferences.test.ts.
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

describe("getDashboard — descriptor is passed through, NOT read-normalized", () => {
  it("hands out an ar_ descriptor unchanged (the only shape on disk)", async () => {
    dashboardRow!.descriptor = {
      version: 3,
      sections: [
        { areaId: Area.encode(AREA_UUID_1), cards: [] },
        { areaId: Area.encode(AREA_UUID_2), cards: [] },
      ],
    };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dashboard?.descriptor.sections.map((s) => s.areaId)).toEqual([
      Area.encode(AREA_UUID_1),
      Area.encode(AREA_UUID_2),
    ]);
  });

  it("does NOT launder a raw-uuid section ref — it surfaces verbatim", async () => {
    dashboardRow!.descriptor = {
      version: 3,
      sections: [{ areaId: AREA_UUID_1, cards: [] }],
    };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    // Pre-Phase-14 this returned Area.encode(AREA_UUID_1). The inversion is the assertion.
    expect(dashboard?.descriptor.sections[0].areaId).toBe(AREA_UUID_1);
    expect(dashboard?.descriptor.sections[0].areaId).not.toBe(
      Area.encode(AREA_UUID_1),
    );
  });

  it("leaves a non-v3 descriptor untouched", async () => {
    dashboardRow!.descriptor = { version: 2, cards: [] };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dashboard?.descriptor).toEqual({ version: 2, cards: [] });
  });
});
