import { describe, it, expect } from "@jest/globals";
import { PointReference } from "@/lib/identifiers";
import { buildFlowSeries } from "@/lib/aggregation/flow-series";
import { computeFlowAccounting } from "@/lib/aggregation/flow-matrix-core";
import type {
  LogicalSystem,
  LogicalSystemPoint,
} from "@/lib/aggregation/logical-system";
import type { AggRow } from "@/lib/history/build-series";
import { buildFlowMatrixFromAggRows } from "@/lib/history/build-flow-matrix";
import { shapeAttributedFlowMatrix } from "@/lib/history/build-attributed-flow-matrix";

// Same fixture as lib/history/__tests__/build-flow-matrix.test.ts — the P2 tripwire: the attributed
// builder's energy leg (shapeAttributedFlowMatrix, fed a `computeFlowAccounting` run with no
// sourceIntensities/window — the "energy-only" projection) must equal `buildFlowMatrixFromAggRows`'s
// energy-only matrix for the SAME underlying series, node-for-node. If the two builders' series
// assembly (or node sort/label/color resolution) ever diverges, this test catches it.

const T = [300_000, 600_000, 900_000];

const KW: Record<string, (number | null)[]> = {
  "source.solar.local": [1, 2, 1],
  "bidi.battery": [-1, 0.5, 0.5],
  "bidi.grid": [2, -0.5, 0],
  "load.hws": [1, 1.5, 1],
};

function mkPoint(
  pointId: number,
  stem: string,
  displayName: string,
): LogicalSystemPoint {
  return {
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

const LS: LogicalSystem = {
  id: 6,
  areaId: "area-test-6",
  timezoneOffsetMin: 600,
  points: POINTS,
  isComplete: true,
};

function makeAggRows(points: LogicalSystemPoint[]): AggRow[] {
  const rows: AggRow[] = [];
  for (const p of points) {
    const kw = KW[p.stem];
    for (let i = 0; i < T.length; i++) {
      const w = kw[i] === null ? null : (kw[i] as number) * 1000;
      rows.push({
        system_id: p.ref.systemId,
        point_id: p.ref.pointId,
        interval_end: T[i],
        avg: w,
      });
    }
  }
  return rows;
}

describe("shapeAttributedFlowMatrix — P2 energy-legs-equivalence tripwire", () => {
  it("matches buildFlowMatrixFromAggRows node-for-node when fed the equivalent series", () => {
    // The "energy-only" reference, built the way /api/history's sub-daily energy leg already is.
    const energyOnly = buildFlowMatrixFromAggRows(makeAggRows(POINTS), LS)!;
    expect(energyOnly).not.toBeNull();

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
