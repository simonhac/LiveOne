import { describe, it, expect } from "@jest/globals";
import { PointReference } from "@/lib/identifiers";
import { Point } from "@/lib/ids";
import { buildFlowSeries } from "@/lib/aggregation/flow-series";
import { computeFlowAccounting } from "@/lib/aggregation/flow-matrix-core";
import type { LogicalSystemPoint } from "@/lib/aggregation/logical-system";
import { computeFlowMatrix } from "@/lib/aggregation/flow-matrix-core";
import { toEnergyFlowMatrix } from "@/lib/aggregation/flow-node-meta";
import { shapeAttributedFlowMatrix } from "@/lib/history/build-attributed-flow-matrix";

// The P2 tripwire: the attributed builder's energy leg (shapeAttributedFlowMatrix, fed a
// `computeFlowAccounting` run with no sourceIntensities/window — the "energy-only" projection) must
// equal the energy-only matrix (`computeFlowMatrix` → `toEnergyFlowMatrix`, the path the retired
// server `flowMatrix` was built on) for the SAME underlying series, node-for-node. If the shaping
// (node sort/label/color resolution) ever diverges from the projection, this test catches it.

const T = [300_000, 600_000, 900_000];

const KW: Record<string, (number | null)[]> = {
  "source.solar.local": [1, 2, 1],
  "bidi.battery": [-1, 0.5, 0.5],
  "bidi.grid": [2, -0.5, 0],
  "load.hws": [1, 1.5, 1],
};

/** A synthetic but VALID uuid per point index — `LogicalSystemPoint.point` is a real `PointId`. */
const uid = (pointId: number) =>
  Point.encode(`019ec06c-f635-7000-8000-${String(pointId).padStart(12, "0")}`);

function mkPoint(
  pointId: number,
  stem: string,
  displayName: string,
): LogicalSystemPoint {
  return {
    point: uid(pointId),
    ref: PointReference.fromIds(6, pointId),
    stem,
    metricType: "power",
    metricUnit: "W",
    transform: null,
    displayName,
  };
}

const POINTS: LogicalSystemPoint[] = [
  mkPoint(1, "source.solar.local", "Solar Local"),
  mkPoint(2, "bidi.battery", "Battery"),
  mkPoint(3, "bidi.grid", "Grid"),
  mkPoint(4, "load.hws", "Hot Water"),
];

describe("shapeAttributedFlowMatrix — P2 energy-legs-equivalence tripwire", () => {
  it("matches the energy-only projection node-for-node when fed the equivalent series", () => {
    // The "energy-only" reference: the same series through computeFlowMatrix + toEnergyFlowMatrix —
    // exactly how the retired server `flowMatrix` was assembled.
    const refClassified = POINTS.map((p) => ({
      stem: p.stem,
      power: KW[p.stem],
    }));
    const ref = buildFlowSeries(refClassified);
    const refResult = computeFlowMatrix({
      timestamps: T,
      sources: ref.sources,
      loads: ref.loads,
    });
    const energyOnly = toEnergyFlowMatrix(
      refResult.sources,
      refResult.loads,
      refResult.matrix,
      new Map(POINTS.map((p) => [p.stem, p.displayName])),
    );

    // The attributed builder's series assembly (mirrors loadFlowSeriesFromAgg5m's classification: kW
    // series per point → buildFlowSeries) + the shared computeFlowAccounting core (no intensities/window
    // → pure energy projection, same math computeFlowMatrix delegates to).
    const classified = POINTS.map((p) => ({ stem: p.stem, power: KW[p.stem] }));
    const { sources, loads } = buildFlowSeries(classified);
    const acc = computeFlowAccounting({ timestamps: T, sources, loads });

    const displayNameByStem = new Map(
      POINTS.map((p) => [p.stem, p.displayName]),
    );
    const attributed = shapeAttributedFlowMatrix(
      acc,
      "2026-07-01",
      displayNameByStem,
    );

    expect(attributed.sources).toEqual(energyOnly.sources);
    expect(attributed.loads).toEqual(energyOnly.loads);
    expect(attributed.days).toHaveLength(1);
    expect(attributed.days[0].matrix).toEqual(energyOnly.matrix);
  });

  it("shapes the metric legs as null wherever no energy attributed a known intensity", () => {
    const classified = POINTS.map((p) => ({ stem: p.stem, power: KW[p.stem] }));
    const { sources, loads } = buildFlowSeries(classified);
    // No sourceIntensities supplied — every cell's intensity is "unknown" by construction.
    const acc = computeFlowAccounting({
      timestamps: T,
      sources,
      loads,
      sourceIntensities: sources.map(() => null),
    });
    const displayNameByStem = new Map(
      POINTS.map((p) => [p.stem, p.displayName]),
    );
    const attributed = shapeAttributedFlowMatrix(
      acc,
      "2026-07-01",
      displayNameByStem,
    );

    const day = attributed.days[0];
    expect(day.matrix.some((row) => row.some((v) => v > 0))).toBe(true); // energy still flows
    for (const row of day.emissionsG!)
      for (const v of row) expect(v).toBeNull();
    for (const row of day.renewableKwh!)
      for (const v of row) expect(v).toBeNull();
    for (const row of day.costC!) for (const v of row) expect(v).toBeNull();
    // Every kWh of energy is "estimated" (unknown intensity counts as estimated).
    const totalEnergy = day.matrix.flat().reduce((a, b) => a + b, 0);
    const totalEstimated = day.estimatedKwh!.flat().reduce((a, b) => a + b, 0);
    expect(totalEstimated).toBeCloseTo(totalEnergy, 6);
  });
});
