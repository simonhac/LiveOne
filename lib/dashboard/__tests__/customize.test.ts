import { describe, it, expect } from "@jest/globals";
import {
  buildDefaultDescriptor,
  normalizeDescriptor,
  tilesConfigOf,
  isCardVisible,
  type DashboardDescriptor,
} from "../descriptor";
import { TILE_IDS, availableTiles } from "../cards";
import type { LatestPointValues } from "@/lib/types/api";

const EMPTY = {} as LatestPointValues;
const sidebarDefault = () =>
  buildDefaultDescriptor({ vendorType: "selectronic" }, EMPTY);

describe("buildDefaultDescriptor (v2)", () => {
  it("is version 2 with a tiles card carrying the full default order", () => {
    const d = sidebarDefault();
    expect(d.version).toBe(2);
    const cfg = tilesConfigOf(d);
    expect(cfg.order).toEqual([...TILE_IDS]);
    expect(cfg.hidden).toEqual([]);
  });
});

describe("normalizeDescriptor", () => {
  it("returns the default when there is no saved descriptor / it is malformed", () => {
    const def = sidebarDefault();
    expect(normalizeDescriptor(null, def)).toBe(def);
    expect(normalizeDescriptor({ junk: true }, def)).toBe(def);
  });

  it("discards a saved descriptor whose layout no longer matches (vendor changed)", () => {
    const def = sidebarDefault();
    const stale: DashboardDescriptor = {
      version: 2,
      layout: "site",
      cards: [{ type: "tiles", tiles: { order: [], hidden: [] } }],
    };
    expect(normalizeDescriptor(stale, def)).toBe(def);
  });

  it("keeps saved hidden/order and appends newly-introduced cards", () => {
    const def = sidebarDefault();
    const saved: DashboardDescriptor = {
      version: 2,
      layout: "sidebar",
      cards: [
        {
          type: "tiles",
          // only 2 of the tiles, reordered; "battery" hidden
          tiles: { order: ["grid", "solar"], hidden: ["battery"] },
        },
        { type: "energy-chart", hidden: true },
      ],
    };
    const out = normalizeDescriptor(saved, def);
    const cfg = tilesConfigOf(out);
    // saved order preserved first, the rest appended
    expect(cfg.order.slice(0, 2)).toEqual(["grid", "solar"]);
    expect(new Set(cfg.order)).toEqual(new Set(TILE_IDS));
    expect(cfg.hidden).toEqual(["battery"]);
    expect(isCardVisible(out, "energy-chart")).toBe(false);
    expect(isCardVisible(out, "tiles")).toBe(true);
  });

  it("drops unknown tile ids from a saved order", () => {
    const def = sidebarDefault();
    const saved = {
      version: 2,
      layout: "sidebar",
      cards: [
        {
          type: "tiles",
          tiles: { order: ["solar", "bogus"], hidden: ["nope"] },
        },
      ],
    };
    const cfg = tilesConfigOf(normalizeDescriptor(saved, def));
    expect(cfg.order).not.toContain("bogus");
    expect(cfg.hidden).not.toContain("nope");
    expect(new Set(cfg.order)).toEqual(new Set(TILE_IDS));
  });

  // Backward-compat read for the expand→migrate→contract rename: a legacy saved descriptor with the
  // old monolithic "amber" module must still load, expanding to amber-now + amber-timeline and
  // inheriting the old module's hidden state. Keep until the descriptor data migration ships.
  it("migrates a legacy 'amber' module to amber-now + amber-timeline", () => {
    const def = buildDefaultDescriptor({ vendorType: "amber" }, EMPTY);
    const legacy = {
      version: 2,
      layout: "amber",
      cards: [{ type: "amber", hidden: true }],
    };
    const out = normalizeDescriptor(legacy, def);
    expect(out.cards.map((c) => c.type)).toEqual([
      "amber-now",
      "amber-timeline",
    ]);
    expect(isCardVisible(out, "amber-now")).toBe(false);
    expect(isCardVisible(out, "amber-timeline")).toBe(false);
  });

  // Backward-compat read for the expand→migrate→contract rename: a legacy saved descriptor with the
  // old "power-cards" module (carrying a `powerCards` config) must still load, becoming the new
  // "tiles" module (with a `tiles` config) and preserving its order/hidden. Keep until the data
  // migration ships.
  it("migrates a legacy 'power-cards' module to 'tiles'", () => {
    const def = sidebarDefault();
    const legacy = {
      version: 2,
      layout: "sidebar",
      cards: [
        {
          type: "power-cards",
          powerCards: { order: ["grid", "solar"], hidden: ["battery"] },
        },
        { type: "energy-chart" },
        { type: "generator-runs" },
      ],
    };
    const out = normalizeDescriptor(legacy, def);
    // The legacy power-cards module is read as the new "tiles" module.
    expect(out.cards.some((c) => c.type === "tiles")).toBe(true);
    expect(out.cards.some((c) => (c.type as string) === "power-cards")).toBe(
      false,
    );
    const cfg = tilesConfigOf(out);
    expect(cfg.order.slice(0, 2)).toEqual(["grid", "solar"]);
    expect(cfg.hidden).toContain("battery");
  });
});

describe("availableTiles", () => {
  it("returns the cards a system's latest values support, in canonical order", () => {
    const latest = {
      "source.solar/power": { value: 1000 },
      "bidi.battery/soc": { value: 80 },
      "bidi.grid/power": { value: -200 },
    } as unknown as LatestPointValues;
    // solar + (load synthesised from solar/grid) + battery + grid; no amber/ev
    expect(availableTiles(latest)).toEqual([
      "solar",
      "load",
      "battery",
      "grid",
    ]);
  });

  it("is empty for a system with no power data", () => {
    expect(availableTiles(EMPTY)).toEqual([]);
  });
});
