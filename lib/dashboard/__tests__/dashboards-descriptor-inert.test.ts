import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * `dashboards.descriptor` is INERT — config-v4 Phase 14 stage 15.
 *
 * This suite used to assert that `rowToDashboard` handed the descriptor out VERBATIM (Phase 14 having
 * removed the read-normalize that laundered a raw-uuid section ref into `ar_`). That property is moot
 * now: nothing reads the column, so there is nothing to launder.
 *
 * What replaces it is the precondition **stage 16 depends on**, and it is worth an executable gate
 * rather than a claim in a PR body: a row may still carry a `descriptor` — the column is dropped in a
 * later PR and every existing row has one — and reading it must not surface, consume, or care about
 * it. If anyone re-declares the column in `schema.ts` and re-exposes it on `CompositionDashboard`,
 * this file goes red, and the DROP that follows would otherwise have 500'd every projection-less
 * `.select()` in the running build.
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
    // Exactly what every row on prod and dev still looks like until stage 16 drops the column.
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
