import { describe, it, expect } from "@jest/globals";
import {
  buildDefaultDescriptor,
  normalizeDescriptor,
  isCardVisible,
  cardIdentity,
  type DashboardDescriptor,
  type ModuleCardInstance,
} from "../descriptor";
import type { LatestPointValues } from "@/lib/types/api";

const EMPTY = {} as LatestPointValues;

// Phase 3 of the chart-generalization: descriptor cards carry an optional per-instance `id`, and
// reconciliation/visibility key on `id ?? type` so a layout can hold >1 card of the same type. For
// today's singletons (no id) the identity IS the type, so everything must behave exactly as before.

describe("cardIdentity", () => {
  it("is the explicit id when present, else the type", () => {
    expect(cardIdentity({ type: "energy-chart" })).toBe("energy-chart");
    expect(cardIdentity({ type: "energy-chart", id: "chart:lines" })).toBe(
      "chart:lines",
    );
  });
});

describe("normalizeDescriptor — singleton back-compat (id == type)", () => {
  const sidebarDefault = () =>
    buildDefaultDescriptor({ vendorType: "selectronic" }, EMPTY);

  it("emits NO id for singleton cards (byte-identical persisted shape)", () => {
    const out = normalizeDescriptor(sidebarDefault(), sidebarDefault());
    for (const c of out.cards) {
      expect("id" in c).toBe(false);
    }
  });

  it("still keeps saved order + hidden, appends new defaults, drops removed (by type)", () => {
    const def = sidebarDefault();
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "sidebar",
      cards: [
        { type: "energy-chart", hidden: true },
        { type: "tiles", tiles: { order: ["grid", "solar"], hidden: ["ev"] } },
        // a type no longer in the default → dropped
        { type: "sankey" as ModuleCardInstance["type"] },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    // saved order first (energy-chart, tiles), then appended default (generator-runs); sankey dropped
    expect(out.cards.map((c) => c.type)).toEqual([
      "energy-chart",
      "tiles",
      "generator-runs",
    ]);
    expect(isCardVisible(out, "energy-chart")).toBe(false); // hidden carried
    expect(
      out.cards.find((c) => c.type === "tiles")?.tiles?.order.slice(0, 2),
    ).toEqual(["grid", "solar"]);
  });
});

describe("normalizeDescriptor — multi-instance (same type, distinct ids)", () => {
  // A hand-built layout with two cards of the same type, distinguished by id — the shape phase 4's
  // `chart` card will use. The reconcile logic is type-agnostic, so we exercise it directly.
  const def: DashboardDescriptor = {
    version: 2,
    layout: "site",
    cards: [
      { type: "energy-chart", id: "chart:a" },
      { type: "energy-chart", id: "chart:b" },
    ],
  };

  it("keeps BOTH instances, honouring saved order + per-instance hidden", () => {
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "site",
      cards: [
        { type: "energy-chart", id: "chart:b", hidden: true },
        { type: "energy-chart", id: "chart:a" },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    expect(out.cards.map((c) => c.id)).toEqual(["chart:b", "chart:a"]); // saved order
    expect(out.cards.every((c) => c.type === "energy-chart")).toBe(true);
    expect(isCardVisible(out, "chart:b")).toBe(false); // hidden by id
    expect(isCardVisible(out, "chart:a")).toBe(true);
  });

  it("appends a default instance the save didn't have (as visible)", () => {
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "site",
      cards: [{ type: "energy-chart", id: "chart:a", hidden: true }],
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
        { type: "energy-chart", id: "chart:a" },
        { type: "energy-chart", id: "chart:gone" },
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
      { type: "energy-chart", id: "chart:a" },
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
