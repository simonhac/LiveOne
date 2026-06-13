import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";
import {
  convertCompositeToBindings,
  assertCompositeRoundTrip,
  type ConverterPointInfo,
} from "@/lib/areas/convert";
import { PointReference } from "@/lib/identifiers";

interface Fixture {
  composites: Array<{
    id: number;
    displayName: string;
    alias: string | null;
    vendorType: string;
    metadata: unknown;
  }>;
  childPointInfo: Array<{
    systemId: number;
    pointIndex: number;
    logicalPathStem: string | null;
    metricType: string;
    metricUnit: string;
    transform: string | null;
    displayName: string;
  }>;
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/composites.real.json"), "utf8"),
);

const points: ConverterPointInfo[] = fixture.childPointInfo.map((p) => ({
  systemId: p.systemId,
  pointIndex: p.pointIndex,
  logicalPathStem: p.logicalPathStem,
  metricType: p.metricType,
  transform: p.transform,
}));

const pointByRef = new Map(
  fixture.childPointInfo.map((p) => [`${p.systemId}.${p.pointIndex}`, p]),
);

/** Legacy point set: exactly what PointManager._resolveCompositeSystemPoints parses from v2. */
function legacyV2PointSet(metadata: any): Set<string> {
  const set = new Set<string>();
  for (const refs of Object.values(metadata.mappings) as string[][]) {
    if (!Array.isArray(refs)) continue;
    for (const refStr of refs) {
      const ref = PointReference.parse(refStr);
      if (ref) set.add(`${ref.systemId}.${ref.pointId}`);
    }
  }
  return set;
}

describe("convertCompositeToBindings — v2 round-trip against real prod composites", () => {
  const v2Composites = fixture.composites.filter(
    (c) => (c.metadata as any)?.version === 2,
  );

  it("covers the real composites (Craig #7, Kinkora #8) and they are all v2", () => {
    expect(v2Composites.map((c) => c.id).sort()).toEqual([7, 8]);
    expect(v2Composites.length).toBe(fixture.composites.length);
  });

  for (const composite of fixture.composites) {
    describe(`${composite.displayName} (#${composite.id})`, () => {
      const bindings = convertCompositeToBindings(composite.metadata, points);

      it("binding point set EQUALS the legacy resolved point set (no point gained/lost)", () => {
        const bindingSet = new Set(
          bindings.map((b) => `${b.pointSystemId}.${b.pointId}`),
        );
        expect(bindingSet).toEqual(legacyV2PointSet(composite.metadata));
      });

      it("every binding's metric_type matches its point_info row", () => {
        for (const b of bindings) {
          const pi = pointByRef.get(`${b.pointSystemId}.${b.pointId}`);
          expect(pi).toBeDefined();
          expect(b.metricType).toBe(pi!.metricType);
        }
      });

      it("every binding's role is a mapping bucket key", () => {
        const buckets = Object.keys((composite.metadata as any).mappings);
        for (const b of bindings) expect(buckets).toContain(b.role);
      });

      it("ordinals are dense and unique (0..n-1)", () => {
        const ordinals = bindings.map((b) => b.ordinal).sort((a, c) => a - c);
        expect(ordinals).toEqual(bindings.map((_, i) => i));
      });

      it("passes the backfill script's shared round-trip gate", () => {
        expect(() =>
          assertCompositeRoundTrip(composite.metadata, bindings),
        ).not.toThrow();
      });
    });
  }
});

describe("convertCompositeToBindings — base_system/overrides round-trip (synthetic, no prod rows)", () => {
  // getSourceForMetric, verbatim from CompositeAdapter.
  const sourceForMetric = (metric: string, metadata: any): number | null => {
    if (metadata.overrides && metric in metadata.overrides) {
      return metadata.overrides[metric] ?? null;
    }
    return metadata.base_system ?? null;
  };

  // System 2 has full role coverage (solar/battery/load/grid power + battery soc); system 3 has a
  // master solar power point. Mirrors the stale adapter example { base_system:2, overrides:{solar:3} }.
  const metadata = { base_system: 2, overrides: { solar: 3 } };

  it("derives the same per-metric source system as getSourceForMetric", () => {
    const bindings = convertCompositeToBindings(metadata, points);
    const systemOf = (role: string, metricType: string): number | undefined =>
      bindings.find((b) => b.role === role && b.metricType === metricType)
        ?.pointSystemId;

    expect(systemOf("solar", "power")).toBe(sourceForMetric("solar", metadata)); // 3
    expect(systemOf("battery", "power")).toBe(
      sourceForMetric("battery", metadata),
    ); // 2
    expect(systemOf("battery", "soc")).toBe(
      sourceForMetric("battery_soc", metadata),
    ); // 2
    expect(systemOf("load", "power")).toBe(sourceForMetric("load", metadata)); // 2
    expect(systemOf("grid", "power")).toBe(sourceForMetric("grid", metadata)); // 2
  });

  it("resolves battery to TWO bindings (power + soc)", () => {
    const bindings = convertCompositeToBindings(metadata, points);
    const battery = bindings.filter((b) => b.role === "battery");
    expect(battery.map((b) => b.metricType).sort()).toEqual(["power", "soc"]);
  });
});

describe("convertCompositeToBindings — unsupported shapes throw", () => {
  it("throws on the v1 path-string form", () => {
    expect(() =>
      convertCompositeToBindings("liveone.system1.source.solar", points),
    ).toThrow(/unsupported composite metadata shape/);
  });

  it("throws on null / empty", () => {
    expect(() => convertCompositeToBindings(null, points)).toThrow();
    expect(() => convertCompositeToBindings({}, points)).toThrow();
  });

  it("throws when a v2 ref points at a missing point_info row", () => {
    const bad = { version: 2, mappings: { solar: ["999.1"] } };
    expect(() => convertCompositeToBindings(bad, points)).toThrow(
      /not found in point_info/,
    );
  });
});
