import { describe, it, expect } from "@jest/globals";
import { computeFlowMatrix, FlowSeries } from "../flow-matrix-core";
import {
  computeFlowAttribution,
  SourceIntensity,
} from "../flow-attribution-core";

const HOUR = 60 * 60 * 1000;
const ts = (n: number) => {
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => base + i * HOUR);
};

/** A constant-intensity source series of length n. */
function constIntensity(
  n: number,
  emissions: number | null,
  renewable: number | null,
  price: number | null,
  estimated = false,
): SourceIntensity {
  return {
    emissions: new Array(n).fill(emissions),
    renewable: new Array(n).fill(renewable),
    selfRenewable: new Array(n).fill(renewable),
    price: new Array(n).fill(price),
    estimated: new Array(n).fill(estimated),
  };
}

function cell(paths: string[], p: string) {
  return paths.indexOf(p);
}

describe("computeFlowAttribution", () => {
  it("its energy matrix is byte-identical to computeFlowMatrix", () => {
    const timestamps = ts(3);
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [6, 8, 4] },
      { path: "source.grid", power: [4, 2, 0] },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [8, 7, 3] },
      { path: "load.battery", power: [2, 3, 1] },
    ];
    const energy = computeFlowMatrix({ timestamps, sources, loads });
    const attr = computeFlowAttribution({
      timestamps,
      sources,
      loads,
      sourceIntensities: [
        constIntensity(3, 0, 1, 0),
        constIntensity(3, 500, 0.2, 30),
      ],
    });
    for (let s = 0; s < sources.length; s++) {
      for (let l = 0; l < loads.length; l++) {
        expect(attr.energyKwh[s][l]).toBeCloseTo(energy.matrix[s][l], 9);
      }
    }
  });

  it("attributes emissions/renewable/cost = energy × source intensity (conservation)", () => {
    const timestamps = ts(2);
    // 10 kW grid @ 500 g/kWh, 0.2 renewable, 30 c/kWh feeds a 10 kW load for 1 h.
    const sources: FlowSeries[] = [{ path: "source.grid", power: [10, 10] }];
    const loads: FlowSeries[] = [{ path: "load", power: [10, 10] }];
    const attr = computeFlowAttribution({
      timestamps,
      sources,
      loads,
      sourceIntensities: [constIntensity(2, 500, 0.2, 30)],
    });
    expect(attr.energyKwh[0][0]).toBeCloseTo(10, 9);
    expect(attr.emissionsG[0][0]).toBeCloseTo(10 * 500, 6); // 5000 g
    expect(attr.renewableKwh[0][0]).toBeCloseTo(10 * 0.2, 9); // 2 kWh
    expect(attr.costC[0][0]).toBeCloseTo(10 * 30, 6); // 300 c
    expect(attr.estimatedKwh[0][0]).toBe(0);
  });

  it("solar carries 0 emissions, 100% renewable, and its configured cost", () => {
    const timestamps = ts(2);
    const sources: FlowSeries[] = [{ path: "source.solar", power: [5, 5] }];
    const loads: FlowSeries[] = [{ path: "load", power: [5, 5] }];
    const attr = computeFlowAttribution({
      timestamps,
      sources,
      loads,
      sourceIntensities: [constIntensity(2, 0, 1, 0)],
    });
    expect(attr.emissionsG[0][0]).toBeCloseTo(0, 9);
    expect(attr.renewableKwh[0][0]).toBeCloseTo(5, 9);
    expect(attr.costC[0][0]).toBeCloseTo(0, 9);
  });

  it("distributes a source's emissions across the loads it serves (per-load split)", () => {
    const timestamps = ts(2);
    // Grid 10 kW → 6 kW load.ev + 4 kW load.rest for 1h; all grid.
    const sources: FlowSeries[] = [{ path: "source.grid", power: [10, 10] }];
    const loads: FlowSeries[] = [
      { path: "load.ev", power: [6, 6] },
      { path: "load.rest-of-house", power: [4, 4] },
    ];
    const attr = computeFlowAttribution({
      timestamps,
      sources,
      loads,
      sourceIntensities: [constIntensity(2, 500, 0, 40)],
    });
    const ev = cell(attr.loads, "load.ev");
    const rest = cell(attr.loads, "load.rest-of-house");
    expect(attr.emissionsG[0][ev]).toBeCloseTo(6 * 500, 6);
    expect(attr.emissionsG[0][rest]).toBeCloseTo(4 * 500, 6);
    // Total attributed = total consumed.
    expect(attr.emissionsG[0][ev] + attr.emissionsG[0][rest]).toBeCloseTo(
      10 * 500,
      6,
    );
  });

  it("counts energy with unknown/estimated intensity into estimatedKwh and the coverage denominators", () => {
    const timestamps = ts(2);
    const sources: FlowSeries[] = [{ path: "source.grid", power: [10, 10] }];
    const loads: FlowSeries[] = [{ path: "load", power: [10, 10] }];

    // price unknown (null) → costC excludes it, priceKnownKwh stays 0, estimatedKwh counts it.
    const attr = computeFlowAttribution({
      timestamps,
      sources,
      loads,
      sourceIntensities: [constIntensity(2, 500, 0.2, null)],
    });
    expect(attr.emissionsG[0][0]).toBeCloseTo(5000, 6);
    expect(attr.emissionsKnownKwh[0][0]).toBeCloseTo(10, 9);
    expect(attr.priceKnownKwh[0][0]).toBe(0);
    expect(attr.costC[0][0]).toBe(0);
    expect(attr.estimatedKwh[0][0]).toBeCloseTo(10, 9);

    // avg emissions intensity = emissionsG / emissionsKnownKwh = 500 (unbiased).
    expect(attr.emissionsG[0][0] / attr.emissionsKnownKwh[0][0]).toBeCloseTo(
      500,
      6,
    );
  });

  it("a null source intensity marks all its contributions estimated", () => {
    const timestamps = ts(2);
    const sources: FlowSeries[] = [{ path: "source.battery", power: [5, 5] }];
    const loads: FlowSeries[] = [{ path: "load", power: [5, 5] }];
    const attr = computeFlowAttribution({
      timestamps,
      sources,
      loads,
      sourceIntensities: [null],
    });
    expect(attr.energyKwh[0][0]).toBeCloseTo(5, 9);
    expect(attr.estimatedKwh[0][0]).toBeCloseTo(5, 9);
    expect(attr.emissionsG[0][0]).toBe(0);
    expect(attr.emissionsKnownKwh[0][0]).toBe(0);
  });
});
