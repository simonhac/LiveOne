import { describe, it, expect } from "@jest/globals";
import {
  buildDefaultDescriptor,
  normalizeDescriptor,
  isCardVisible,
  cardIdentity,
  type DashboardDescriptor,
} from "../descriptor";
import { CARD_REGISTRY } from "../cards";
import type { LatestPointValues } from "@/lib/types/api";

const EMPTY = {} as LatestPointValues;

// Phase 3 + 4 of the chart-generalization: descriptor cards carry an optional per-instance `id`, and
// reconciliation/visibility key on `id ?? type` so a layout can hold >1 card of the same type (the
// `chart` card). Non-chart singletons (no id) still behave exactly as before.

describe("cardIdentity", () => {
  it("is the explicit id when present, else the type", () => {
    expect(cardIdentity({ type: "generator-runs" })).toBe("generator-runs");
    expect(cardIdentity({ type: "chart", id: "chart:lines" })).toBe(
      "chart:lines",
    );
  });
});

describe("normalizeDescriptor — singleton back-compat", () => {
  const sidebarDefault = () =>
    buildDefaultDescriptor({ vendorType: "selectronic" }, EMPTY);

  it("emits ids only for instance (chart) cards, not singletons", () => {
    const out = normalizeDescriptor(sidebarDefault(), sidebarDefault());
    const tiles = out.cards.find((c) => c.type === "tiles");
    const gen = out.cards.find((c) => c.type === "generator-runs");
    expect("id" in tiles!).toBe(false);
    expect("id" in gen!).toBe(false);
    expect(out.cards.find((c) => c.type === "chart")?.id).toBe("chart:lines");
  });

  it("keeps saved order + hidden, appends new defaults, drops removed", () => {
    const def = sidebarDefault(); // [tiles, chart:lines, generator-runs]
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "sidebar",
      cards: [
        { type: "generator-runs", hidden: true },
        { type: "tiles", tiles: { order: ["grid", "solar"], hidden: ["ev"] } },
        // a type not in the sidebar default → dropped
        { type: "amber-now" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    // saved order first (generator-runs, tiles), then the appended default (chart:lines)
    expect(out.cards.map((c) => c.id ?? c.type)).toEqual([
      "generator-runs",
      "tiles",
      "chart:lines",
    ]);
    expect(isCardVisible(out, "generator-runs")).toBe(false); // hidden carried
    expect(
      out.cards.find((c) => c.type === "tiles")?.tiles?.order.slice(0, 2),
    ).toEqual(["grid", "solar"]);
  });
});

describe("normalizeDescriptor — multi-instance (same type, distinct ids)", () => {
  // Two cards of the same type distinguished by id — the shape the `chart` card uses.
  const def: DashboardDescriptor = {
    version: 2,
    layout: "site",
    cards: [
      { type: "chart", id: "chart:a" },
      { type: "chart", id: "chart:b" },
    ],
  };

  it("keeps BOTH instances, honouring saved order + per-instance hidden", () => {
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "site",
      cards: [
        { type: "chart", id: "chart:b", hidden: true },
        { type: "chart", id: "chart:a" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id)).toEqual(["chart:b", "chart:a"]); // saved order
    expect(out.cards.every((c) => c.type === "chart")).toBe(true);
    expect(isCardVisible(out, "chart:b")).toBe(false); // hidden by id
    expect(isCardVisible(out, "chart:a")).toBe(true);
  });

  it("appends a default instance the save didn't have (as visible)", () => {
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "site",
      cards: [{ type: "chart", id: "chart:a", hidden: true }],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id)).toEqual(["chart:a", "chart:b"]);
    expect(isCardVisible(out, "chart:b")).toBe(true); // introduced since save → visible default
  });

  it("drops a saved instance no longer in the default", () => {
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "site",
      cards: [
        { type: "chart", id: "chart:a" },
        { type: "chart", id: "chart:gone" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id)).toEqual(["chart:a", "chart:b"]);
    expect(out.cards.some((c) => c.id === "chart:gone")).toBe(false);
  });
});

describe("isCardVisible — by id or type", () => {
  const d: DashboardDescriptor = {
    version: 2,
    layout: "site",
    cards: [
      { type: "chart", id: "chart:a" },
      { type: "tiles", hidden: true },
    ],
  };
  it("matches an instance by id", () => {
    expect(isCardVisible(d, "chart:a")).toBe(true);
  });
  it("matches a singleton by type", () => {
    expect(isCardVisible(d, "tiles")).toBe(false);
  });
  it("is false for an absent card", () => {
    expect(isCardVisible(d, "sankey")).toBe(false);
  });
});

describe("chart card — legacy read-shim", () => {
  it("expands a legacy site-charts save into the two stacked chart instances (hidden carried)", () => {
    const def = buildDefaultDescriptor({ vendorType: "mondo" }, EMPTY);
    const saved = {
      version: 2,
      layout: "site",
      cards: [
        { type: "tiles", tiles: { order: ["solar"], hidden: [] } },
        { type: "site-charts", hidden: true },
        { type: "sankey" },
        { type: "generator-runs" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id ?? c.type)).toEqual([
      "tiles",
      "chart:load",
      "chart:generation",
      "sankey",
      "generator-runs",
    ]);
    // The single hidden site-charts carried its hidden state onto BOTH halves.
    expect(isCardVisible(out, "chart:load")).toBe(false);
    expect(isCardVisible(out, "chart:generation")).toBe(false);
  });

  it("expands a legacy energy-chart save into the lines chart instance", () => {
    const def = buildDefaultDescriptor({ vendorType: "selectronic" }, EMPTY);
    const saved = {
      version: 2,
      layout: "sidebar",
      cards: [
        { type: "tiles", tiles: { order: ["solar"], hidden: [] } },
        { type: "energy-chart" },
        { type: "generator-runs" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id ?? c.type)).toEqual([
      "tiles",
      "chart:lines",
      "generator-runs",
    ]);
    expect(isCardVisible(out, "chart:lines")).toBe(true);
  });
});

describe("chart instance ids never collide with a card type (guardrail)", () => {
  it("every default chart id is 'chart:'-namespaced and not a CARD_REGISTRY key", () => {
    for (const vendorType of ["mondo", "selectronic"]) {
      const d = buildDefaultDescriptor({ vendorType }, EMPTY);
      for (const c of d.cards) {
        if (c.id === undefined) continue;
        expect(c.id.startsWith("chart:")).toBe(true);
        expect(c.id in CARD_REGISTRY).toBe(false);
      }
    }
  });
});

// Edge cases backing the phase-4 UI behaviours (hide/reorder a chart card; no double-expansion).
describe("chart card — customized round-trip + shim idempotency", () => {
  it("preserves a hidden + reordered chart instance on a current (non-legacy) save", () => {
    const def = buildDefaultDescriptor({ vendorType: "mondo" }, EMPTY);
    // user hid Generation and moved it before Load
    const saved = {
      version: 2,
      layout: "site",
      cards: [
        { type: "tiles", tiles: { order: ["solar"], hidden: [] } },
        {
          type: "chart",
          id: "chart:generation",
          hidden: true,
          chart: { variant: "stacked-areas", split: "generation" },
        },
        {
          type: "chart",
          id: "chart:load",
          chart: { variant: "stacked-areas", split: "load" },
        },
        { type: "sankey" },
        { type: "generator-runs" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id ?? c.type)).toEqual([
      "tiles",
      "chart:generation",
      "chart:load",
      "sankey",
      "generator-runs",
    ]);
    expect(isCardVisible(out, "chart:generation")).toBe(false); // hide sticks per-instance
    expect(isCardVisible(out, "chart:load")).toBe(true);
    // chart config sourced from the canonical default
    expect(out.cards.find((c) => c.id === "chart:load")?.chart).toEqual({
      variant: "stacked-areas",
      split: "load",
    });
  });

  it("normalize is idempotent on an already-migrated descriptor (no double-expand, unique ids)", () => {
    const def = buildDefaultDescriptor({ vendorType: "mondo" }, EMPTY);
    const out1 = normalizeDescriptor(def, def);
    const out2 = normalizeDescriptor(out1, def);
    expect(out2).toEqual(out1);
    const ids = out2.cards.map((c) => c.id ?? c.type);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate chart instances
  });

  it("preserves legacy relative order: site-charts before tiles → chart pair before tiles", () => {
    const def = buildDefaultDescriptor({ vendorType: "mondo" }, EMPTY);
    const saved = {
      version: 2,
      layout: "site",
      cards: [
        { type: "site-charts" },
        { type: "tiles", tiles: { order: ["solar"], hidden: [] } },
        { type: "sankey" },
        { type: "generator-runs" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id ?? c.type)).toEqual([
      "chart:load",
      "chart:generation",
      "tiles",
      "sankey",
      "generator-runs",
    ]);
  });
});
