import { describe, it, expect } from "@jest/globals";
import {
  buildDefaultDescriptor,
  hasLegacyCards,
  migrateLegacyDescriptor,
  migrateLegacyDescriptorRow,
  type DashboardDescriptor,
} from "../descriptor";
import type { LatestPointValues } from "@/lib/types/api";

const EMPTY = {} as LatestPointValues;

// These cover the WRITE side of the expand→migrate→contract rename (the data migration in
// scripts/migrate-dashboard-descriptors.ts). The READ side (normalizeDescriptor) is covered in
// customize.test.ts; here we assert the row-level transform + the skip/idempotency guarantees the
// migration relies on.

describe("hasLegacyCards", () => {
  it("is true only when a MODULE card.type is a legacy type", () => {
    expect(hasLegacyCards({ cards: [{ type: "amber" }] })).toBe(true);
    expect(
      hasLegacyCards({ cards: [{ type: "power-cards", powerCards: {} }] }),
    ).toBe(true);
    expect(
      hasLegacyCards({ cards: [{ type: "tiles" }, { type: "amber-now" }] }),
    ).toBe(false);
  });

  it("does NOT match the 'amber' TileId or 'amber' layout (only card.type)", () => {
    // amber is also a TileId (inside a tiles config) and a DashboardLayout value.
    expect(
      hasLegacyCards({
        layout: "amber",
        cards: [{ type: "tiles", tiles: { order: ["amber"], hidden: [] } }],
      }),
    ).toBe(false);
  });

  it("returns false for current default descriptors of every layout (byte-unchanged guarantee)", () => {
    for (const vendorType of ["amber", "selectronic", "mondo"]) {
      const def = buildDefaultDescriptor({ vendorType }, EMPTY);
      expect(hasLegacyCards(def)).toBe(false);
    }
  });

  it("is false for malformed / non-descriptor values (no throw)", () => {
    expect(hasLegacyCards(null)).toBe(false);
    expect(hasLegacyCards(undefined)).toBe(false);
    expect(hasLegacyCards(42)).toBe(false);
    expect(hasLegacyCards({})).toBe(false);
    expect(hasLegacyCards({ cards: "nope" })).toBe(false);
    expect(hasLegacyCards({ cards: [null, { notype: 1 }] })).toBe(false);
  });
});

describe("migrateLegacyDescriptorRow", () => {
  it("renames power-cards -> tiles, copying the powerCards config and preserving version/layout/hidden", () => {
    const next = migrateLegacyDescriptorRow({
      version: 2,
      layout: "sidebar",
      cards: [
        {
          type: "power-cards",
          powerCards: { order: ["grid", "solar"], hidden: ["battery"] },
          hidden: true,
        },
        { type: "energy-chart" },
      ],
    });
    expect(next).not.toBeNull();
    expect(next!.version).toBe(2);
    expect(next!.layout).toBe("sidebar");
    const tiles = next!.cards!.find((c) => c.type === "tiles");
    expect(tiles).toMatchObject({
      type: "tiles",
      tiles: { order: ["grid", "solar"], hidden: ["battery"] },
      hidden: true,
    });
    expect(next!.cards!.some((c) => (c.type as string) === "power-cards")).toBe(
      false,
    );
    expect(next!.cards!.map((c) => c.type)).toContain("energy-chart");
  });

  it("expands amber -> amber-now + amber-timeline, both inheriting hidden", () => {
    const next = migrateLegacyDescriptorRow({
      version: 2,
      layout: "amber",
      cards: [{ type: "amber", hidden: true }],
    });
    expect(next!.cards!.map((c) => c.type)).toEqual([
      "amber-now",
      "amber-timeline",
    ]);
    expect(next!.cards!.every((c) => c.hidden === true)).toBe(true);
  });

  it("returns null for an already-current row (skip → byte-unchanged)", () => {
    const def = buildDefaultDescriptor({ vendorType: "selectronic" }, EMPTY);
    expect(migrateLegacyDescriptorRow(def)).toBeNull();
  });

  it("is idempotent: the output has no legacy cards, so a second pass is a no-op", () => {
    const next = migrateLegacyDescriptorRow({
      version: 2,
      layout: "amber",
      cards: [{ type: "amber" }],
    });
    expect(hasLegacyCards(next)).toBe(false);
    expect(migrateLegacyDescriptorRow(next)).toBeNull();
  });

  it("dedupes a mixed legacy+new row first-wins (amber alongside amber-now)", () => {
    const next = migrateLegacyDescriptorRow({
      version: 2,
      layout: "amber",
      cards: [{ type: "amber" }, { type: "amber-now", hidden: true }],
    });
    // amber expands to amber-now + amber-timeline; the trailing amber-now is a dupe and dropped.
    expect(next!.cards!.map((c) => c.type)).toEqual([
      "amber-now",
      "amber-timeline",
    ]);
  });

  it("does not throw on a legacy card with a null/non-object sibling (passes it through)", () => {
    const next = migrateLegacyDescriptorRow({
      version: 2,
      layout: "amber",
      cards: [null, { type: "amber", hidden: false }],
    });
    expect(next!.cards!.map((c) => c?.type ?? null)).toEqual([
      null,
      "amber-now",
      "amber-timeline",
    ]);
  });

  it("produces a plain JSON-serializable object (safe for the jsonb column)", () => {
    const next = migrateLegacyDescriptorRow({
      version: 2,
      layout: "sidebar",
      cards: [{ type: "power-cards", powerCards: { order: [], hidden: [] } }],
    });
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });

  it("migrateLegacyDescriptor (read-path core) leaves an already-current descriptor unchanged", () => {
    const def: DashboardDescriptor = buildDefaultDescriptor(
      { vendorType: "selectronic" },
      EMPTY,
    );
    expect(migrateLegacyDescriptor(def)).toEqual(def);
  });
});
