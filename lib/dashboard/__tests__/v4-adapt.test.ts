import { describe, it, expect } from "@jest/globals";
import {
  isTileViewType,
  isV3CardType,
  synthCardV3,
  synthSectionV3,
  v4CardRenderKind,
} from "../v4-adapt";
import type { CardNode } from "../v4";

describe("v4→v3 adapter classification", () => {
  it("isTileViewType covers the 9 promoted tile views only", () => {
    for (const t of [
      "solar",
      "load",
      "hotWater",
      "battery",
      "house-to-grid",
      "amber",
      "ev",
      "renewables",
      "oe-grid",
    ]) {
      expect(isTileViewType(t)).toBe(true);
    }
    for (const t of ["chart", "sankey", "generator-runs", "tiles", "nope"]) {
      expect(isTileViewType(t)).toBe(false);
    }
  });

  it("isV3CardType covers v3 card types (not tile views, not tiles)", () => {
    for (const t of [
      "chart",
      "sankey",
      "amber-now",
      "generator-runs",
      "device-metrics",
      "battery-contents",
    ]) {
      expect(isV3CardType(t)).toBe(true);
    }
    for (const t of ["solar", "oe-grid", "tiles", "future-card"]) {
      expect(isV3CardType(t)).toBe(false);
    }
  });

  it("routes an unknown string to the labelled-placeholder branch", () => {
    expect(v4CardRenderKind("solar")).toBe("tile");
    expect(v4CardRenderKind("chart")).toBe("v3");
    expect(v4CardRenderKind("future-card")).toBe("unknown");
  });
});

describe("synthCardV3", () => {
  it("maps a chart node's config to the v3 chart field", () => {
    const node: CardNode = {
      kind: "card",
      type: "chart",
      id: "n_1",
      config: { variant: "stacked-areas", split: "load" },
    };
    expect(synthCardV3(node)).toEqual({
      type: "chart",
      id: "n_1",
      chart: { variant: "stacked-areas", split: "load" },
    });
  });

  it("maps a device-metrics node's variant + the resolved device handle", () => {
    const node: CardNode = {
      kind: "card",
      type: "device-metrics",
      config: { variant: "table" },
    };
    expect(synthCardV3(node, 5)).toEqual({
      type: "device-metrics",
      variant: "table",
      deviceSystemId: 5,
    });
  });

  it("preserves id + hidden and omits config for a bare card", () => {
    const node: CardNode = {
      kind: "card",
      type: "sankey",
      id: "n_2",
      hidden: true,
    };
    expect(synthCardV3(node)).toEqual({
      type: "sankey",
      id: "n_2",
      hidden: true,
    });
  });
});

describe("synthSectionV3", () => {
  it("carries the area uuid and an empty cards list", () => {
    expect(synthSectionV3("abc-uuid")).toEqual({
      areaId: "abc-uuid",
      cards: [],
    });
    expect(synthSectionV3(undefined)).toEqual({ areaId: "", cards: [] });
  });
});
