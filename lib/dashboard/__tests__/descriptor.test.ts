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

  it("mondo/composite → site layout with power-cards, site-charts, sankey, generator-runs", () => {
    for (const vt of ["mondo", "composite"]) {
      const d = buildDefaultDescriptor({ vendorType: vt }, latest);
      expect(d.layout).toBe("site");
      expect(d.cards.map((c) => c.type)).toEqual([
        "power-cards",
        "site-charts",
        "sankey",
        "generator-runs",
      ]);
    }
  });

  it("every other vendor → sidebar layout with power-cards, energy-chart, generator-runs", () => {
    for (const vt of ["selectronic", "enphase", "fronius", "tesla", "fusher"]) {
      const d = buildDefaultDescriptor({ vendorType: vt }, latest);
      expect(d.layout).toBe("sidebar");
      expect(d.cards.map((c) => c.type)).toEqual([
        "power-cards",
        "energy-chart",
        "generator-runs",
      ]);
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
  it("power-cards for everything except amber", () => {
    expect(CARD_REGISTRY["power-cards"].canRender(ctx("selectronic"))).toBe(
      true,
    );
    expect(CARD_REGISTRY["power-cards"].canRender(ctx("composite"))).toBe(true);
    expect(CARD_REGISTRY["power-cards"].canRender(ctx("amber"))).toBe(false);
  });
  it("site-charts/sankey only for site (mondo/composite) systems", () => {
    expect(CARD_REGISTRY["site-charts"].canRender(ctx("mondo"))).toBe(true);
    expect(CARD_REGISTRY.sankey.canRender(ctx("composite"))).toBe(true);
    expect(CARD_REGISTRY["site-charts"].canRender(ctx("selectronic"))).toBe(
      false,
    );
  });
  it("energy-chart for non-amber, non-site systems", () => {
    expect(CARD_REGISTRY["energy-chart"].canRender(ctx("selectronic"))).toBe(
      true,
    );
    expect(CARD_REGISTRY["energy-chart"].canRender(ctx("amber"))).toBe(false);
    expect(CARD_REGISTRY["energy-chart"].canRender(ctx("mondo"))).toBe(false);
  });
});
