/**
 * Provenance is written PER AREA, and the legacy columns refuse to guess.
 *
 * 🛑 The defect this locks down. A run's cost is area-relative — the Kutis EV charger sits in its own
 * area-of-one AND in High Street Kew, and only the latter binds the Amber meter — but provenance was
 * four columns on `derived_intervals` with no area on the row. So `resolveSiteForDetector` chose one
 * of the device's areas by `ORDER BY ordinal, areas.id LIMIT 1`, the unpriceable one won, and every
 * Kutis EV run stored $0.00 for two months while the Sankey priced the same energy correctly. The
 * writer now enumerates instead of choosing.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";
import type { PointId } from "@/lib/ids";
import type { IntensitySeries } from "@/lib/run-tracking/intensity";

interface StoredRun {
  derivationId: string;
  startTime: Date;
  energyKwh: number | null;
  costC: number | null;
  emissionsG: number | null;
  renewableKwh: number | null;
  estimatedKwh: number | null;
}
interface StoredProvenance extends StoredRun {
  areaId: string;
}

const KEW = "area-kew";
const AREA_OF_ONE = "area-of-one";

/** What `resolveIntensitySeriesByArea` returns for this pass — the knob each test turns. */
let areaSeries: { areaId: string; series: IntensitySeries }[] = [];
let runRows: StoredRun[] = [];
let provRows: StoredProvenance[] = [];

const readRaw =
  jest.fn<
    (
      ids: PointId[],
      window: { fromMs: number; toMs: number },
    ) => Promise<Map<PointId, { measurementTimeMs: number; value: number }[]>>
  >();

jest.mock("@/lib/readings", () => ({
  ReadingsDao: {
    readRaw: (ids: PointId[], window: { fromMs: number; toMs: number }) =>
      readRaw(ids, window),
  },
}));
jest.mock("@/lib/run-tracking/intensity", () => ({
  resolveIntensitySeriesByArea: async () => areaSeries,
}));
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));

import { recomputeIntervalsForWindow } from "../derived-intervals-pg";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-09-08T00:00:00Z");
const NOW = T0 + 2 * DAY;
const RUN_START = T0 + 2 * HOUR;
const RUN_END = T0 + 4 * HOUR;
const SAMPLE_MS = 5 * MIN;

const SIGNAL = "pt_signal" as unknown as PointId;
const ENERGY = "pt_energy" as unknown as PointId;

const DETECTOR = {
  id: "dx-ev",
  signalPoint: SIGNAL,
  energyPoint: ENERGY,
  signalUnit: "W",
  detectorVersion: 1,
  detect: {
    upperW: 1000,
    lowerW: null,
    hysteresisW: 0,
    delayOnMs: 5 * MIN,
    delayOffMs: 30 * MIN,
    nowMs: NOW,
    boundaryMode: "edge" as const,
  },
} as unknown as ResolvedRunDetector;

/** A flat factor series — the price is all that differs between the two areas under test. */
function flat(priceC: number | null): IntensitySeries {
  return {
    at: () => ({
      priceC,
      gPerKwh: 100,
      renewable: 0.5,
      estimatedFraction: priceC === null ? 1 : 0,
    }),
  } as unknown as IntensitySeries;
}

function signalSeries(fromMs: number, toMs: number) {
  const out: { measurementTimeMs: number; value: number }[] = [];
  for (
    let t = Math.ceil(fromMs / SAMPLE_MS) * SAMPLE_MS;
    t <= toMs;
    t += SAMPLE_MS
  )
    out.push({
      measurementTimeMs: t,
      value: t >= RUN_START && t <= RUN_END ? 6000 : 0,
    });
  return out;
}

/** Wh counter tracking the signal: 6 kW for 5 min = 500 Wh per sample while running. */
function energySeries(fromMs: number, toMs: number) {
  const out: { measurementTimeMs: number; value: number }[] = [];
  for (
    let t = Math.ceil(fromMs / SAMPLE_MS) * SAMPLE_MS;
    t <= toMs;
    t += SAMPLE_MS
  ) {
    const ranFor = Math.min(Math.max(t - RUN_START, 0), RUN_END - RUN_START);
    out.push({ measurementTimeMs: t, value: (ranFor / SAMPLE_MS) * 500 });
  }
  return out;
}

/**
 * The slice of the drizzle surface the recompute drives. Both inserts land through the same `insert`,
 * so they are told apart by the shape of the rows — which is also how the test proves the per-area
 * rows carry an `areaId` and the run rows do not.
 */
function fakeDb() {
  const tx = {
    execute: async () => ({ rows: [] }),
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
    insert: () => ({
      values: async (rows: (StoredRun | StoredProvenance)[]) => {
        for (const r of rows) {
          if ("areaId" in r) provRows.push(r as StoredProvenance);
          else runRows.push(r as StoredRun);
        }
      },
    }),
  };
  return {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as never;
}

async function recompute() {
  return recomputeIntervalsForWindow(fakeDb(), DETECTOR, T0, T0 + DAY, NOW);
}

beforeEach(() => {
  jest.clearAllMocks();
  areaSeries = [];
  runRows = [];
  provRows = [];
  readRaw.mockImplementation(async (ids, window) => {
    const id = ids[0];
    return new Map([
      [
        id,
        id === SIGNAL
          ? signalSeries(window.fromMs, window.toMs)
          : energySeries(window.fromMs, window.toMs),
      ],
    ]);
  });
});

describe("per-area run provenance", () => {
  it("writes one provenance row per area, each with that area's own numbers", async () => {
    areaSeries = [
      { areaId: KEW, series: flat(30) },
      { areaId: AREA_OF_ONE, series: flat(0) },
    ];

    await recompute();

    expect(runRows).toHaveLength(1);
    expect(provRows).toHaveLength(2);
    const kwh = runRows[0].energyKwh!;
    expect(kwh).toBeCloseTo(12, 3);
    // 12 kWh at 30 c/kWh through Kew; the same 12 kWh at 0 through the area-of-one. BOTH are stored:
    // neither is "the" answer, which is the entire point of the table.
    expect(provRows.find((p) => p.areaId === KEW)!.costC).toBeCloseTo(360, 3);
    expect(provRows.find((p) => p.areaId === AREA_OF_ONE)!.costC).toBe(0);
    // Keyed to the run, so the composite FK (and therefore the CASCADE on recompute) matches.
    for (const p of provRows) {
      expect(p.derivationId).toBe(DETECTOR.id);
      expect(p.startTime.getTime()).toBe(runRows[0].startTime.getTime());
    }
  });

  it("leaves the legacy columns NULL when two areas disagree, rather than picking one", async () => {
    areaSeries = [
      { areaId: KEW, series: flat(30) },
      { areaId: AREA_OF_ONE, series: flat(0) },
    ];

    await recompute();

    // 🛑 The regression guard. Storing EITHER number here would be the old defect: $3.60 or $0.00
    // presented as the answer to a question ("what did this run cost?") that has two of them.
    expect(runRows[0].costC).toBeNull();
    expect(runRows[0].emissionsG).toBeNull();
    expect(runRows[0].renewableKwh).toBeNull();
    expect(runRows[0].estimatedKwh).toBeNull();
  });

  it("still fills the legacy columns when exactly one area can price the run", async () => {
    // Every device in the fleet bar one. The dropped `LIMIT 1` was correct here and only here, so
    // single-area behaviour must be byte-identical to before the change.
    areaSeries = [{ areaId: KEW, series: flat(30) }];

    await recompute();

    expect(runRows[0].costC).toBeCloseTo(360, 3);
    expect(provRows).toHaveLength(1);
    expect(provRows[0].areaId).toBe(KEW);
    expect(provRows[0].costC).toBeCloseTo(360, 3);
  });

  it("writes no provenance row at all when no area can price the run", async () => {
    areaSeries = [];

    await recompute();

    expect(runRows).toHaveLength(1);
    expect(runRows[0].costC).toBeNull();
    // Absence IS the unknown — there is no all-null row to be mistaken for a computed verdict.
    expect(provRows).toHaveLength(0);
  });

  it("records an area that knows NOTHING as fully-estimated, not as free", async () => {
    // The "unknown ≠ zero" contract, now per-area: an area whose every factor is null prices nothing,
    // so its row carries null cost and the run's WHOLE energy as `estimated_kwh` — the confidence
    // denominator that stops the silence reading as a cheap run. Kew's row is unaffected by it.
    areaSeries = [
      { areaId: KEW, series: flat(30) },
      {
        areaId: AREA_OF_ONE,
        series: {
          at: () => ({
            priceC: null,
            gPerKwh: null,
            renewable: null,
            estimatedFraction: 1,
          }),
        } as unknown as IntensitySeries,
      },
    ];

    await recompute();

    const blind = provRows.find((p) => p.areaId === AREA_OF_ONE)!;
    expect(blind.costC).toBeNull();
    expect(blind.emissionsG).toBeNull();
    expect(blind.estimatedKwh).toBeCloseTo(12, 3);
    expect(provRows.find((p) => p.areaId === KEW)!.costC).toBeCloseTo(360, 3);
  });
});
