import { describe, it, expect } from "@jest/globals";
import { PointReference } from "@/lib/identifiers";
import { buildFlowSeries } from "@/lib/aggregation/flow-series";
import { computeFlowMatrix } from "@/lib/aggregation/flow-matrix-core";
import { toEnergyFlowMatrix } from "@/lib/aggregation/flow-node-meta";
import type {
  LogicalSystem,
  LogicalSystemPoint,
} from "@/lib/aggregation/logical-system";
import type { AggRow } from "@/lib/history/build-series";
import { buildFlowMatrixFromAggRows } from "@/lib/history/build-flow-matrix";

// 5-minute timeline (epoch-ms).
const T = [300_000, 600_000, 900_000];

// Ground-truth power series in kW (what the shared core integrates).
const KW: Record<string, (number | null)[]> = {
  "source.solar.local": [1, 2, 1],
  "bidi.battery": [-1, 0.5, 0.5], // charge then discharge → exercises the source/load split
  "bidi.grid": [2, -0.5, 0], // import then export
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
  energyPoints: [],
  isComplete: true,
};

/** allRows as the history fetch holds them: raw avg in WATTS (toKw will /1000). */
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

/** The "engine" answer: classify the kW series directly through the shared core (honouring `transform`). */
function expectedMatrix(points: LogicalSystemPoint[]) {
  const classified = points.map((p) => ({
    stem: p.stem,
    power:
      p.transform === "i"
        ? KW[p.stem].map((v) => (v === null ? null : -v))
        : KW[p.stem],
  }));
  const { sources, loads } = buildFlowSeries(classified);
  const result = computeFlowMatrix({ timestamps: T, sources, loads });
  const names = new Map(points.map((p) => [p.stem, p.displayName]));
  return toEnergyFlowMatrix(result.sources, result.loads, result.matrix, names);
}

describe("buildFlowMatrixFromAggRows", () => {
  it("reconstructs the engine matrix from in-memory 5m rows (incl. W→kW + node meta)", () => {
    const actual = buildFlowMatrixFromAggRows(makeAggRows(POINTS), LS);
    expect(actual).toEqual(expectedMatrix(POINTS));
  });

  it("produces directional battery/grid nodes (not collapsed) with correct labels/colors", () => {
    const m = buildFlowMatrixFromAggRows(makeAggRows(POINTS), LS)!;
    const sourceLabels = m.sources.map((s) => s.label);
    const loadLabels = m.loads.map((l) => l.label);
    expect(sourceLabels).toContain("Battery Discharge");
    expect(sourceLabels).toContain("Grid Import");
    expect(loadLabels).toContain("Battery Charge");
    expect(loadLabels).toContain("Grid Export");
    expect(sourceLabels).toContain("Solar Local"); // from displayName
    expect(loadLabels).toContain("Hot Water");
    // Battery node colour resolves (not the gray fallback).
    const battery = m.sources.find((s) => s.label === "Battery Discharge")!;
    expect(battery.color).toBe("rgb(74, 222, 128)");
    // Energy conservation: every cell ≥ 0 and totals reconcile.
    expect(m.totalEnergy).toBeCloseTo(
      m.sourceTotals.reduce((a, b) => a + b, 0),
      9,
    );
  });

  it("skips role points absent from the fetched window", () => {
    const partial = POINTS.filter((p) => p.stem !== "load.hws");
    // Only solar/battery/grid rows present; hws omitted.
    const actual = buildFlowMatrixFromAggRows(makeAggRows(partial), LS);
    expect(actual).toEqual(expectedMatrix(partial));
    expect(actual!.loads.map((l) => l.label)).not.toContain("Hot Water");
  });

  it("returns null when no rows are supplied", () => {
    expect(buildFlowMatrixFromAggRows([], LS)).toBeNull();
  });

  it("applies a point's invert transform ('i') — a grid wired so import reads negative", () => {
    // Daylesford's case: the AC-source/grid channel is a generator, wired so IMPORT reads negative.
    // transform 'i' negates it before the source/load split, so the generator's feed-in is counted as
    // Grid Import (a source), not Grid Export (a load). The raw rows are unchanged — the builder inverts.
    const points = POINTS.map((p) =>
      p.stem === "bidi.grid" ? { ...p, transform: "i" as string } : p,
    );
    const ls: LogicalSystem = { ...LS, points };

    const actual = buildFlowMatrixFromAggRows(makeAggRows(points), ls);
    // Matches the core run on the INVERTED grid series, and DIFFERS from the un-inverted matrix.
    expect(actual).toEqual(expectedMatrix(points));
    expect(actual).not.toEqual(expectedMatrix(POINTS));
  });
});

describe("buildFlowMatrixFromAggRows — exact-energy overlays", () => {
  // The battery's directional PAIR registers (metric energy, Wh deltas). Their rows carry `delta`.
  const ENERGY_POINTS: LogicalSystemPoint[] = [
    {
      ...mkPoint(20, "bidi.battery.charge", "Battery Charge Wh"),
      metricType: "energy",
    },
    {
      ...mkPoint(21, "bidi.battery.discharge", "Battery Discharge Wh"),
      metricType: "energy",
    },
  ];
  const LS_E: LogicalSystem = { ...LS, energyPoints: ENERGY_POINTS };

  /** Wh deltas by slot (aligned to T); slot i = energy over (T[i-1], T[i]]. */
  function energyRows(deltas: Record<number, (number | null)[]>): AggRow[] {
    const rows: AggRow[] = [];
    for (const p of ENERGY_POINTS) {
      const d = deltas[p.ref.pointId];
      if (!d) continue;
      for (let i = 0; i < T.length; i++)
        rows.push({
          system_id: p.ref.systemId,
          point_id: p.ref.pointId,
          interval_end: T[i],
          delta: d[i],
        });
    }
    return rows;
  }

  it("prefers pair deltas: a flip interval keeps gross charge AND discharge", () => {
    // Interval 0 (T0→T1): the signed power says 0.5 kW net "discharge"; the registers say the
    // battery BOTH charged 100 Wh and discharged 80 Wh. Gross must survive.
    const rows = [
      ...makeAggRows(POINTS),
      ...energyRows({
        20: [null, 100, 0], // charge Wh at slot 1 → interval 0
        21: [null, 80, 0], // discharge Wh at slot 1 → interval 0
      }),
    ];
    const m = buildFlowMatrixFromAggRows(rows, LS_E)!;
    const chargeCol = m.loads.find((l) => l.label === "Battery Charge")!;
    const dischargeRow = m.sources.find(
      (s) => s.label === "Battery Discharge",
    )!;
    const lb = m.loads.indexOf(chargeCol);
    const sb = m.sources.indexOf(dischargeRow);
    // Exact register magnitudes (Wh → kWh) — interval 1 falls back to the power split.
    expect(m.loadTotals[lb]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(m.sourceTotals[sb]).toBeGreaterThan(0);
    // No battery→battery self-flow even though both halves are nonzero in the flip interval.
    expect(m.matrix[sb][lb]).toBeCloseTo(0, 12);
    // The power-only control nets the flip: its charge column total is strictly smaller.
    const powerOnly = buildFlowMatrixFromAggRows(makeAggRows(POINTS), LS_E)!;
    const lbP = powerOnly.loads.findIndex((l) => l.label === "Battery Charge");
    const controlCharge = lbP === -1 ? 0 : powerOnly.loadTotals[lbP];
    expect(m.loadTotals[lb]).toBeGreaterThan(controlCharge);
  });

  it("missing energy rows never omit the Sankey — falls back to the power matrix", () => {
    // energyPoints declared on the logical system, but the fetch returned no delta rows.
    const actual = buildFlowMatrixFromAggRows(makeAggRows(POINTS), LS_E);
    expect(actual).toEqual(expectedMatrix(POINTS));
  });
});
