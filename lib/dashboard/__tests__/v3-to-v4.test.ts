import { describe, it, expect } from "@jest/globals";
import { Area, Device, newUuidV7, type DeviceId } from "@/lib/ids";
import {
  rewriteV3ToV4,
  pureAreaRef,
  type LegacyRefResolver,
} from "../v3-to-v4";
import { validateDocV4, collectRefs, normalizeDocV4 } from "../v4-validate";
import { walkNodes } from "../v4";
import { sectionAreaIdsV3, type DashboardV3 } from "../v3";

/** Deterministic-per-run device resolver: each legacy int maps to one minted dv_ id. */
function makeResolver(): {
  resolver: LegacyRefResolver;
  devMap: Map<number, DeviceId>;
} {
  const devMap = new Map<number, DeviceId>();
  const resolver: LegacyRefResolver = {
    areaRef: pureAreaRef,
    deviceRef: (n) => {
      let d = devMap.get(n);
      if (!d) {
        d = Device.encode(newUuidV7());
        devMap.set(n, d);
      }
      return d;
    },
  };
  return { resolver, devMap };
}

function sampleV3(): DashboardV3 {
  const a1 = newUuidV7();
  const a2 = newUuidV7();
  return {
    version: 3,
    sections: [
      {
        areaId: a1,
        cards: [
          {
            type: "tiles",
            tiles: [
              { view: "solar" },
              { view: "battery", deviceSystemId: 14 },
              { view: "oe-grid", deviceSystemId: 14 },
            ],
          },
          { type: "chart", chart: { variant: "stacked-areas", split: "load" } },
          { type: "sankey" },
          { type: "generator-runs", deviceSystemId: 14 },
          { type: "device-metrics", deviceSystemId: 1, variant: "table" },
        ],
      },
      { areaId: a2, hidden: true, cards: [{ type: "amber-now" }] },
    ],
  };
}

describe("rewriteV3ToV4", () => {
  it("produces a valid, normalized v4 doc with no warnings for known types", () => {
    const { resolver } = makeResolver();
    const v4 = rewriteV3ToV4(sampleV3(), resolver);
    const r = validateDocV4(v4);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.valid).toBe(true);
    // already normalized → re-normalize is a no-op
    expect(normalizeDocV4(v4)).toEqual(v4);
    // every node has an id
    let missing = 0;
    walkNodes(v4, (n) => {
      if (!n.id) missing++;
    });
    expect(missing).toBe(0);
  });

  it("preserves share scope: v4 areas === sectionAreaIdsV3(v3) (§8.3)", () => {
    const v3 = sampleV3();
    const { resolver } = makeResolver();
    const v4 = rewriteV3ToV4(v3, resolver);
    const v4AreaUuids = collectRefs(v4)
      .areas.map((a) => Area.toUuid(a))
      .sort();
    // config-v4 Phase 14 stage 15: was `descriptorAreaIds` (composition.ts), which died with the
    // `descriptor` column. `sectionAreaIdsV3` is its v3-native twin and lives beside the shape it
    // reads, so both sides of this equivalence now die together at stage 16.
    const v3AreaUuids = [...sectionAreaIdsV3(v3)].sort();
    expect(v4AreaUuids).toEqual(v3AreaUuids);
  });

  it("maps the v3 'tiles' card to a row group of leaf cards", () => {
    const { resolver } = makeResolver();
    const v4 = rewriteV3ToV4(sampleV3(), resolver);
    const section1 = v4.root.children[0];
    expect(section1.kind).toBe("group");
    const tilesGroup = (section1 as { children: unknown[] }).children[0] as {
      kind: string;
      direction?: string;
      wrap?: boolean;
      children: { kind: string }[];
    };
    expect(tilesGroup.kind).toBe("group");
    expect(tilesGroup.direction).toBe("row");
    expect(tilesGroup.wrap).toBe(true);
    expect(tilesGroup.children).toHaveLength(3);
    expect(tilesGroup.children.every((c) => c.kind === "card")).toBe(true);
  });

  it("preserves the leaf-card count (non-tiles cards + all tiles)", () => {
    const { resolver } = makeResolver();
    const v4 = rewriteV3ToV4(sampleV3(), resolver);
    let cards = 0;
    walkNodes(v4, (n) => {
      if (n.kind === "card") cards++;
    });
    // section1: chart, sankey, generator-runs, device-metrics (4) + 3 tiles; section2: amber-now (1)
    expect(cards).toBe(8);
  });

  it("dedups device pins (systemId 14 used thrice → one dv_ id) and carries them", () => {
    const { resolver, devMap } = makeResolver();
    const v4 = rewriteV3ToV4(sampleV3(), resolver);
    const devices = collectRefs(v4).devices;
    expect(devMap.size).toBe(2); // legacy 14 and 1
    expect(new Set(devices).size).toBe(2);
    expect(devices).toContain(devMap.get(14));
    expect(devices).toContain(devMap.get(1));
  });

  it("preserves hidden sections and chart config", () => {
    const { resolver } = makeResolver();
    const v4 = rewriteV3ToV4(sampleV3(), resolver);
    const section2 = v4.root.children[1] as { hidden?: boolean };
    expect(section2.hidden).toBe(true);

    let chartConfig: unknown;
    walkNodes(v4, (n) => {
      if (n.kind === "card" && n.type === "chart") chartConfig = n.config;
    });
    expect(chartConfig).toEqual({ variant: "stacked-areas", split: "load" });
  });

  it("defaults a config-less v3 chart card to a valid v4 chart (variant: lines)", () => {
    const { resolver } = makeResolver();
    const v3: DashboardV3 = {
      version: 3,
      sections: [{ areaId: newUuidV7(), cards: [{ type: "chart" }] }],
    };
    const v4 = rewriteV3ToV4(v3, resolver);
    expect(validateDocV4(v4).valid).toBe(true);
    let chartConfig: unknown;
    walkNodes(v4, (n) => {
      if (n.kind === "card" && n.type === "chart") chartConfig = n.config;
    });
    expect(chartConfig).toEqual({ variant: "lines" });
  });

  it("round-trips an empty descriptor", () => {
    const { resolver } = makeResolver();
    const v4 = rewriteV3ToV4({ version: 3, sections: [] }, resolver);
    expect(validateDocV4(v4).valid).toBe(true);
    expect(collectRefs(v4)).toEqual({ areas: [], devices: [] });
  });

  it("dual-accept: an already-`ar_` section.areaId resolves identically to its raw-uuid form", () => {
    const uuid = newUuidV7();
    const { resolver: resolverRaw } = makeResolver();
    const { resolver: resolverArId } = makeResolver();
    const v3Raw: DashboardV3 = {
      version: 3,
      sections: [{ areaId: uuid, cards: [{ type: "amber-now" }] }],
    };
    const v3ArId: DashboardV3 = {
      version: 3,
      sections: [{ areaId: Area.encode(uuid), cards: [{ type: "amber-now" }] }],
    };
    const v4Raw = rewriteV3ToV4(v3Raw, resolverRaw);
    const v4ArId = rewriteV3ToV4(v3ArId, resolverArId);
    expect(collectRefs(v4Raw)).toEqual(collectRefs(v4ArId));
  });
});
