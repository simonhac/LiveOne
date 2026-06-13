import { describe, it, expect } from "@jest/globals";
import { buildDefaultDescriptor } from "../descriptor";
import { CARD_REGISTRY, getLayout } from "../cards";
import type { LatestPointValues } from "@/lib/types/api";

const latest = {} as LatestPointValues;

describe("buildDefaultDescriptor (reproduces the vendor_type ladder)", () => {
  it("amber → amber layout with the amber card", () => {
    const d = buildDefaultDescriptor({ vendorType: "amber" }, latest);
    expect(d.layout).toBe("amber");
    expect(d.cards.map((c) => c.type)).toEqual(["amber"]);
  });

  it("mondo/composite → site layout with power-cards, site-charts, sankey", () => {
    for (const vt of ["mondo", "composite"]) {
      const d = buildDefaultDescriptor({ vendorType: vt }, latest);
      expect(d.layout).toBe("site");
      expect(d.cards.map((c) => c.type)).toEqual([
        "power-cards",
        "site-charts",
        "sankey",
      ]);
    }
  });

  it("every other vendor → sidebar layout with power-cards + energy-chart", () => {
    for (const vt of ["selectronic", "enphase", "fronius", "tesla", "fusher"]) {
      const d = buildDefaultDescriptor({ vendorType: vt }, latest);
      expect(d.layout).toBe("sidebar");
      expect(d.cards.map((c) => c.type)).toEqual([
        "power-cards",
        "energy-chart",
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
  it("amber card only for amber systems", () => {
    expect(CARD_REGISTRY.amber.canRender(ctx("amber"))).toBe(true);
    expect(CARD_REGISTRY.amber.canRender(ctx("mondo"))).toBe(false);
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
