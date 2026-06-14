import { describe, it, expect } from "@jest/globals";
import {
  hasLegacyChartCards,
  migrateLegacyChartCards,
  migrateLegacyChartDescriptorRow,
  buildDefaultDescriptor,
  type ModuleCardInstance,
} from "../descriptor";
import type { LatestPointValues } from "@/lib/types/api";

const EMPTY = {} as LatestPointValues;

// Legacy persisted cards use types no longer in DashboardCardType — cast at the boundary.
const legacy = (cards: unknown[]) => cards as unknown as ModuleCardInstance[];

// WRITE side of PR #83's site-charts/energy-chart → chart rename (scripts/migrate-chart-descriptors.ts).
// The READ side (normalizeDescriptor's shim) is covered in instance-id.test.ts; here we lock the
// row-level transform + skip/idempotency the migration relies on.

describe("hasLegacyChartCards", () => {
  it("is true only when a legacy chart card type is present", () => {
    expect(hasLegacyChartCards({ cards: [{ type: "site-charts" }] })).toBe(
      true,
    );
    expect(hasLegacyChartCards({ cards: [{ type: "energy-chart" }] })).toBe(
      true,
    );
    expect(
      hasLegacyChartCards({ cards: [{ type: "chart", id: "chart:load" }] }),
    ).toBe(false);
    expect(hasLegacyChartCards({ cards: [{ type: "tiles" }] })).toBe(false);
  });
  it("is false for malformed / non-descriptor values (no throw)", () => {
    expect(hasLegacyChartCards(null)).toBe(false);
    expect(hasLegacyChartCards({})).toBe(false);
    expect(hasLegacyChartCards({ cards: "nope" })).toBe(false);
    expect(hasLegacyChartCards({ cards: [null, { notype: 1 }] })).toBe(false);
  });
});

describe("migrateLegacyChartCards", () => {
  it("expands site-charts → chart:load + chart:generation, carrying hidden", () => {
    const out = migrateLegacyChartCards(
      legacy([{ type: "site-charts", hidden: true }]),
    );
    expect(out.map((c) => c.id)).toEqual(["chart:load", "chart:generation"]);
    expect(out.every((c) => c.type === "chart" && c.hidden === true)).toBe(
      true,
    );
    expect(out[0].chart).toEqual({ variant: "stacked-areas", split: "load" });
    expect(out[1].chart).toEqual({
      variant: "stacked-areas",
      split: "generation",
    });
  });
  it("renames energy-chart → chart:lines", () => {
    const out = migrateLegacyChartCards(legacy([{ type: "energy-chart" }]));
    expect(out).toEqual([
      {
        type: "chart",
        id: "chart:lines",
        hidden: undefined,
        chart: { variant: "lines" },
      },
    ]);
  });
  it("passes through non-legacy and malformed cards", () => {
    const out = migrateLegacyChartCards([
      null as never,
      { type: "tiles" },
      { type: "sankey" },
    ]);
    expect(out).toEqual([null, { type: "tiles" }, { type: "sankey" }]);
  });
});

describe("migrateLegacyChartDescriptorRow", () => {
  it("rewrites a legacy row, preserving order + other cards", () => {
    const next = migrateLegacyChartDescriptorRow({
      version: 2,
      layout: "site",
      cards: [
        { type: "tiles" },
        { type: "site-charts" },
        { type: "sankey" },
        { type: "generator-runs" },
      ],
    });
    expect(next!.cards!.map((c) => c.id ?? c.type)).toEqual([
      "tiles",
      "chart:load",
      "chart:generation",
      "sankey",
      "generator-runs",
    ]);
    expect(next!.version).toBe(2);
    expect(next!.layout).toBe("site");
  });

  it("returns null (skip) for an already-current descriptor and is idempotent", () => {
    const def = buildDefaultDescriptor({ vendorType: "mondo" }, EMPTY);
    expect(migrateLegacyChartDescriptorRow(def)).toBeNull();
    // a legacy row, once migrated, has no legacy types → second pass is a no-op
    const migrated = migrateLegacyChartDescriptorRow({
      version: 2,
      layout: "sidebar",
      cards: [{ type: "tiles" }, { type: "energy-chart" }],
    });
    expect(hasLegacyChartCards(migrated)).toBe(false);
    expect(migrateLegacyChartDescriptorRow(migrated)).toBeNull();
  });

  it("produces a plain JSON-serializable object", () => {
    const next = migrateLegacyChartDescriptorRow({
      version: 2,
      layout: "site",
      cards: [{ type: "site-charts" }],
    });
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
});
