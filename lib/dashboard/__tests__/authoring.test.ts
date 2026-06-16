import { describe, it, expect } from "@jest/globals";
import {
  isCardTypeVendorCompatible,
  filterVendorIncompatibleCards,
} from "../composition";
import type { DashboardDescriptor } from "../descriptor";

describe("isCardTypeVendorCompatible (vendor-deterministic gate)", () => {
  it("sankey is site-vendor only", () => {
    expect(isCardTypeVendorCompatible("sankey", "mondo")).toBe(true);
    expect(isCardTypeVendorCompatible("sankey", "composite")).toBe(true);
    expect(isCardTypeVendorCompatible("sankey", "selectronic")).toBe(false);
    expect(isCardTypeVendorCompatible("sankey", "amber")).toBe(false);
  });

  it("tiles and grid-signals are pointless on pure-amber", () => {
    expect(isCardTypeVendorCompatible("tiles", "amber")).toBe(false);
    expect(isCardTypeVendorCompatible("grid-signals", "amber")).toBe(false);
    expect(isCardTypeVendorCompatible("tiles", "selectronic")).toBe(true);
    expect(isCardTypeVendorCompatible("grid-signals", "mondo")).toBe(true);
  });

  it("data-driven and unknown types default to compatible (left to the client/renderer)", () => {
    for (const vt of ["amber", "selectronic", "mondo", "enphase", ""]) {
      expect(isCardTypeVendorCompatible("chart", vt)).toBe(true);
      expect(isCardTypeVendorCompatible("amber-now", vt)).toBe(true);
      expect(isCardTypeVendorCompatible("amber-timeline", vt)).toBe(true);
      expect(isCardTypeVendorCompatible("generator-runs", vt)).toBe(true);
    }
  });
});

describe("filterVendorIncompatibleCards (drop, never reject)", () => {
  const descriptor = (
    cards: DashboardDescriptor["cards"],
  ): DashboardDescriptor => ({
    version: 2,
    layout: "site",
    cards,
  });

  it("drops a sankey bound to a sidebar-vendor area but keeps a chart on the same area", () => {
    const d = descriptor([
      { type: "sankey", id: "s", areaId: "area-sidebar" },
      { type: "chart", id: "c", areaId: "area-sidebar" },
    ]);
    const out = filterVendorIncompatibleCards(
      d,
      new Map([["area-sidebar", "selectronic"]]),
    );
    expect(out.cards.map((c) => c.id)).toEqual(["c"]);
  });

  it("keeps cards whose area has no resolvable vendor type, and areaId-less cards", () => {
    const d = descriptor([
      { type: "sankey", id: "s", areaId: "unknown-area" },
      { type: "sankey", id: "noarea" }, // no areaId → kept
    ]);
    const out = filterVendorIncompatibleCards(d, new Map());
    expect(out.cards.map((c) => c.id)).toEqual(["s", "noarea"]);
  });

  it("returns the same descriptor reference when nothing is dropped", () => {
    const d = descriptor([{ type: "chart", id: "c", areaId: "a" }]);
    const out = filterVendorIncompatibleCards(d, new Map([["a", "mondo"]]));
    expect(out).toBe(d);
  });
});
