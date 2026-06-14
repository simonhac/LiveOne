import { describe, it, expect } from "@jest/globals";
import { buildDefaultDescriptor } from "../descriptor";
import { CARD_REGISTRY, getLayout } from "../cards";
import type { LatestPointValues } from "@/lib/types/api";

const latest = {} as LatestPointValues;

describe("buildDefaultDescriptor (reproduces the vendor_type ladder)", () => {
  it("amber → amber layout with the amber-now + amber-timeline cards", () => {
    const d = buildDefaultDescriptor({ vendorType: "amber" }, latest);
    expect(d.layout).toBe("amber");
    expect(d.cards.map((c) => c.type)).toEqual(["amber-now", "amber-timeline"]);
  });

  it("mondo/composite → site layout with tiles, two stacked charts, sankey, generator-runs", () => {
    for (const vt of ["mondo", "composite"]) {
      const d = buildDefaultDescriptor({ vendorType: vt }, latest);
      expect(d.layout).toBe("site");
      expect(d.cards.map((c) => c.id ?? c.type)).toEqual([
        "tiles",
        "chart:load",
        "chart:generation",
        "sankey",
        "generator-runs",
      ]);
      // The two stacked chart instances carry their split config.
      const load = d.cards.find((c) => c.id === "chart:load");
      const gen = d.cards.find((c) => c.id === "chart:generation");
      expect(load?.chart).toEqual({ variant: "stacked-areas", split: "load" });
      expect(gen?.chart).toEqual({
        variant: "stacked-areas",
        split: "generation",
      });
    }
  });

  it("every other vendor → sidebar layout with tiles, a lines chart, generator-runs", () => {
    for (const vt of ["selectronic", "enphase", "fronius", "tesla", "fusher"]) {
      const d = buildDefaultDescriptor({ vendorType: vt }, latest);
      expect(d.layout).toBe("sidebar");
      expect(d.cards.map((c) => c.id ?? c.type)).toEqual([
        "tiles",
        "chart:lines",
        "generator-runs",
      ]);
      expect(d.cards.find((c) => c.id === "chart:lines")?.chart).toEqual({
        variant: "lines",
      });
    }
  });
});

describe("getLayout", () => {
  it("maps vendor types to layouts", () => {
    expect(getLayout("amber")).toBe("amber");
    expect(getLayout("mondo")).toBe("site");
    expect(getLayout("composite")).toBe("site");
    expect(getLayout("selectronic")).toBe("sidebar");
  });
});

describe("CARD_REGISTRY canRender", () => {
  const ctx = (vendorType: string) => ({ vendorType, latest });
  it("amber-now/amber-timeline are data-driven (import rate point present)", () => {
    const withRate = {
      "bidi.grid.import/rate": { value: 12 },
    } as unknown as LatestPointValues;
    for (const t of ["amber-now", "amber-timeline"] as const) {
      expect(
        CARD_REGISTRY[t].canRender({ vendorType: "amber", latest: withRate }),
      ).toBe(true);
      // No rate point → not eligible (regardless of vendor type).
      expect(CARD_REGISTRY[t].canRender(ctx("amber"))).toBe(false);
    }
  });
  it("tiles for everything except amber", () => {
    expect(CARD_REGISTRY["tiles"].canRender(ctx("selectronic"))).toBe(true);
    expect(CARD_REGISTRY["tiles"].canRender(ctx("composite"))).toBe(true);
    expect(CARD_REGISTRY["tiles"].canRender(ctx("amber"))).toBe(false);
  });
  it("sankey only for site (mondo/composite) systems", () => {
    expect(CARD_REGISTRY.sankey.canRender(ctx("composite"))).toBe(true);
    expect(CARD_REGISTRY.sankey.canRender(ctx("mondo"))).toBe(true);
    expect(CARD_REGISTRY.sankey.canRender(ctx("selectronic"))).toBe(false);
  });
  it("chart is data-driven (solar + load present), NOT vendor-gated", () => {
    const withData = {
      "source.solar/power": { value: 1000 },
      "load/power": { value: 500 },
    } as unknown as LatestPointValues;
    // Eligible for BOTH a site and a sidebar vendor when the data is present.
    expect(
      CARD_REGISTRY.chart.canRender({ vendorType: "mondo", latest: withData }),
    ).toBe(true);
    expect(
      CARD_REGISTRY.chart.canRender({
        vendorType: "selectronic",
        latest: withData,
      }),
    ).toBe(true);
    // No series → not eligible.
    expect(CARD_REGISTRY.chart.canRender(ctx("selectronic"))).toBe(false);
  });
});
