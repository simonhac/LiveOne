import { describe, it, expect } from "@jest/globals";
import {
  cardHeightKey,
  emptyCardHeightStore,
  parseCardHeights,
  rememberedHeight,
  serializeCardHeights,
  viewportTier,
  withMeasurements,
} from "../card-heights";

/**
 * The remembered-height cookie is a rendering HINT that rides on every request and is written by
 * untrusted client code, so the two properties that matter are: it never throws on garbage, and it
 * never grows without bound. Everything below is one of those two.
 */

describe("viewportTier", () => {
  it("buckets on the breakpoints the card layouts actually turn on", () => {
    expect(viewportTier(375)).toBe("sm");
    expect(viewportTier(639)).toBe("sm");
    expect(viewportTier(640)).toBe("md");
    expect(viewportTier(1023)).toBe("md");
    expect(viewportTier(1024)).toBe("lg");
    expect(viewportTier(1960)).toBe("lg");
  });
});

describe("cardHeightKey", () => {
  it("prefers the node id, and always carries the type", () => {
    expect(cardHeightKey("n_7", [0, 1], "chart")).toBe("n_7:chart");
  });

  it("falls back to the index path when a node has no id", () => {
    expect(cardHeightKey(undefined, [0, 1, 2], "sankey")).toBe("@0.1.2:sankey");
  });

  it("distinguishes a retyped node, so a stale height can't be inherited", () => {
    expect(cardHeightKey("n_7", [], "chart")).not.toBe(
      cardHeightKey("n_7", [], "heatmap"),
    );
  });
});

describe("parseCardHeights", () => {
  it("round-trips a store", () => {
    const store = withMeasurements(emptyCardHeightStore("lg"), "db_1", "lg", {
      "n_7:chart": 403,
    })!;
    const wire = serializeCardHeights(store, "db_1")!;
    expect(parseCardHeights(wire)).toEqual(store);
    expect(parseCardHeights(encodeURIComponent(wire))).toEqual(store);
  });

  it("yields an empty store for anything it can't trust", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "not json",
      "{",
      "[]",
      '{"v":2,"t":"lg","d":{"db_1":{"a":1}}}', // future version
      '{"v":1,"t":"lg"}', // no map
      '{"v":1,"t":"lg","d":"nope"}',
    ]) {
      expect(parseCardHeights(bad).byDashboard).toEqual({});
    }
  });

  it("drops entries that aren't plausible heights, keeping the rest", () => {
    const parsed = parseCardHeights(
      JSON.stringify({
        v: 1,
        t: "lg",
        d: {
          db_1: {
            good: 403,
            zero: 0,
            tiny: 5,
            huge: 99999,
            nan: "403",
            inf: Infinity, // JSON.stringify turns this into null
          },
        },
      }),
    );
    expect(parsed.byDashboard.db_1).toEqual({ good: 403 });
  });

  it("defaults an unrecognised tier rather than rejecting the store", () => {
    const parsed = parseCardHeights('{"v":1,"t":"xl","d":{"db_1":{"a":100}}}');
    expect(parsed.tier).toBe("lg");
    expect(parsed.byDashboard.db_1).toEqual({ a: 100 });
  });
});

describe("withMeasurements", () => {
  it("returns null when nothing moved, so the caller can skip the cookie write", () => {
    const store = withMeasurements(emptyCardHeightStore("lg"), "db_1", "lg", {
      a: 100,
    })!;
    expect(withMeasurements(store, "db_1", "lg", { a: 100 })).toBeNull();
    expect(withMeasurements(store, "db_1", "lg", { a: 101 })).toBeNull(); // within tolerance
    expect(withMeasurements(store, "db_1", "lg", { a: 140 })).not.toBeNull();
  });

  it("discards everything on a tier change — those heights describe another layout", () => {
    const lg = withMeasurements(emptyCardHeightStore("lg"), "db_1", "lg", {
      a: 400,
    })!;
    const sm = withMeasurements(lg, "db_1", "sm", { a: 900 })!;
    expect(sm.tier).toBe("sm");
    expect(sm.byDashboard.db_1).toEqual({ a: 900 });
  });

  it("keeps other dashboards' entries when one is updated", () => {
    let store = withMeasurements(emptyCardHeightStore("lg"), "db_1", "lg", {
      a: 400,
    })!;
    store = withMeasurements(store, "db_2", "lg", { b: 500 })!;
    expect(Object.keys(store.byDashboard).sort()).toEqual(["db_1", "db_2"]);
  });

  it("ignores implausible measurements", () => {
    const store = withMeasurements(emptyCardHeightStore("lg"), "db_1", "lg", {
      a: 0,
      b: 9999,
      c: Number.NaN,
    });
    expect(store).toBeNull();
  });
});

describe("serializeCardHeights", () => {
  it("returns null when there is nothing worth writing", () => {
    expect(serializeCardHeights(emptyCardHeightStore("lg"))).toBeNull();
  });

  it("keeps at most three dashboards, never evicting the one being viewed", () => {
    let store = emptyCardHeightStore("lg");
    for (const id of ["db_1", "db_2", "db_3", "db_4"]) {
      store = withMeasurements(store, id, "lg", { a: 400 })!;
    }
    const parsed = parseCardHeights(serializeCardHeights(store, "db_4")!);
    const ids = Object.keys(parsed.byDashboard);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("db_4");
  });

  it("stays under the length cap even for one enormous dashboard", () => {
    const measured: Record<string, number> = {};
    for (let i = 0; i < 400; i++) measured[`node_${i}_with_a_long_key`] = 400;
    const store = withMeasurements(
      emptyCardHeightStore("lg"),
      "db_1",
      "lg",
      measured,
    )!;
    const wire = serializeCardHeights(store, "db_1")!;
    expect(wire.length).toBeLessThanOrEqual(2000);
    // and it is still valid, not truncated mid-string
    expect(
      Object.keys(parseCardHeights(wire).byDashboard.db_1).length,
    ).toBeGreaterThan(0);
  });
});

describe("rememberedHeight", () => {
  it("misses safely", () => {
    const store = withMeasurements(emptyCardHeightStore("lg"), "db_1", "lg", {
      "n_7:chart": 403,
    })!;
    expect(rememberedHeight(store, "db_1", "n_7:chart")).toBe(403);
    expect(rememberedHeight(store, "db_1", "n_8:chart")).toBeUndefined();
    expect(rememberedHeight(store, "db_other", "n_7:chart")).toBeUndefined();
    expect(rememberedHeight(store, null, "n_7:chart")).toBeUndefined();
    expect(rememberedHeight(null, "db_1", "n_7:chart")).toBeUndefined();
  });
});
