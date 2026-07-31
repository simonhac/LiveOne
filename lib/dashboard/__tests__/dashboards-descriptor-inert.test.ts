import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * `dashboards.descriptor` is GONE — config-v4 Phase 14 stages 15 (inert) and 16 (migration 0054
 * dropped the column).
 *
 * This suite used to assert that `rowToDashboard` handed the descriptor out VERBATIM (Phase 14 having
 * removed the read-normalize that laundered a raw-uuid section ref into `ar_`). That property is moot:
 * nothing reads the column, so there is nothing to launder.
 *
 * Stage 15 rewrote it as the executable gate on the DROP. **It is KEPT after the DROP, and its job
 * changes from precondition to standing guard:** nothing may reintroduce a second dashboard shape by
 * re-declaring the column in `schema.ts` and re-exposing it on `CompositionDashboard`. The fixture row
 * below still carries a `descriptor` deliberately — a row shape that no longer exists in the database
 * is exactly the adversarial input this asserts is ignored, so the test does not need the column to
 * exist and does not go stale with it.
 *
 * Mock the drizzle select, table-aware, mirroring lib/__tests__/user-preferences.test.ts.
 */
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

beforeEach(() => {
  dashboardRow = {
    id: DASH_UUID,
    clerkUserId: "owner_1",
    displayName: "Test",
    alias: null,
    doc: {
      version: 4,
      root: {
        kind: "group",
        direction: "column",
        children: [
          { kind: "group", area: Area.encode(AREA_UUID_1), children: [] },
        ],
      },
    },
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
});

describe("getDashboard — `descriptor` is neither read nor surfaced", () => {
  it("does not expose a `descriptor` field, even when the row carries one", async () => {
    // Exactly what every row on prod and dev looked like before migration 0054 dropped the column.
    dashboardRow!.descriptor = {
      version: 3,
      sections: [{ areaId: Area.encode(AREA_UUID_1), cards: [] }],
    };
    const dashboard = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dashboard).not.toBeNull();
    expect(Object.keys(dashboard!)).not.toContain("descriptor");
    expect(dashboard).not.toHaveProperty("descriptor");
  });

  it("is unaffected by the descriptor's content — a garbage one changes nothing", async () => {
    const clean = await getDashboard(Dashboard.encode(DASH_UUID));
    dashboardRow!.descriptor = { version: 2, cards: [{ nonsense: true }] };
    const dirty = await getDashboard(Dashboard.encode(DASH_UUID));
    expect(dirty).toEqual(clean);
  });
});
