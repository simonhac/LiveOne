import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Point, type PointId } from "@/lib/ids";
import type { Agg5mReading, Agg1dReading } from "@/lib/readings";

/**
 * After the config-v4 readings-seam migration `fetchAggRowsPg` is a pure transform over
 * `ReadingsDao` output: it resolves each `(systemId, pointId)` address to a `PointId` via
 * `RegistryCache.pointForAddr`, reads by `PointId`, then densifies (5m/30m) / maps (1d) and
 * reconstructs the `avgCache`. These tests pin that transform against a mocked DAO + registry — the
 * DAO's own SQL/WHERE is proven separately in `lib/readings/__tests__/dao.test.ts`.
 */

// `"systemId.index"` → PointId; populated per test via `register()`.
const addrToPoint = new Map<string, PointId>();

jest.mock("@/lib/registry", () => {
  const actual = jest.requireActual(
    "@/lib/registry",
  ) as typeof import("@/lib/registry");
  return {
    ...actual, // keep the real UnknownIdError so `instanceof` in readings-pg matches
    RegistryCache: {
      pointForAddr: async (
        systemId: number,
        index: number,
      ): Promise<PointId> => {
        const id = addrToPoint.get(`${systemId}.${index}`);
        if (!id)
          throw new actual.UnknownIdError("point-addr", `${systemId}.${index}`);
        return id;
      },
    },
  };
});

// Canned DAO results keyed by PointId; an absent point resolves to [] (the DAO pre-seeds empties).
const read5mByPoint = new Map<PointId, Agg5mReading[]>();
const read1dByPoint = new Map<PointId, Agg1dReading[]>();

jest.mock("@/lib/readings", () => ({
  ReadingsDao: {
    read5m: async (points: PointId[]) =>
      new Map(points.map((pt) => [pt, read5mByPoint.get(pt) ?? []])),
    read1d: async (points: PointId[]) =>
      new Map(points.map((pt) => [pt, read1dByPoint.get(pt) ?? []])),
  },
}));

import { fetchAggRowsPg } from "../readings-pg";
import { Agg5mAvgCache } from "../agg5m-cache";

const FIVE = 5 * 60 * 1000;

function register(systemId: number, index: number): PointId {
  const id = Point.generate();
  addrToPoint.set(`${systemId}.${index}`, id);
  return id;
}

function agg5m(intervalEndMs: number, v: Partial<Agg5mReading>): Agg5mReading {
  return {
    intervalEndMs,
    avg: null,
    min: null,
    max: null,
    last: null,
    delta: null,
    valueStr: null,
    sampleCount: 0,
    errorCount: 0,
    dataQuality: null,
    sessionId: null,
    ...v,
  };
}

function agg1d(day: string, v: Partial<Agg1dReading>): Agg1dReading {
  return {
    day,
    avg: null,
    min: null,
    max: null,
    last: null,
    delta: null,
    sampleCount: 0,
    errorCount: 0,
    ...v,
  };
}

beforeEach(() => {
  addrToPoint.clear();
  read5mByPoint.clear();
  read1dByPoint.clear();
});

describe("fetchAggRowsPg", () => {
  it("1d: maps day rows and emits data_quality:null (PG agg_1d has no such column)", async () => {
    const pt = register(1, 7);
    read1dByPoint.set(pt, [
      agg1d("2026-01-15", { avg: 1.5, min: 0, max: 3, last: 2, delta: 9 }),
    ]);
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 7]],
      interval: "1d",
      startDate: "2026-01-10",
      endDate: "2026-01-20",
    });
    expect(out).toEqual([
      {
        system_id: 1,
        point_id: 7,
        day: "2026-01-15",
        avg: 1.5,
        min: 0,
        max: 3,
        last: 2,
        delta: 9,
        data_quality: null,
      },
    ]);
  });

  it("5m: densifies an ALIGNED range to the exact grid, filling gaps with null", async () => {
    // Sparse: only the 300k interval has data; the rest must come back as null gap rows.
    const pt = register(1, 0);
    read5mByPoint.set(pt, [
      agg5m(300_000, {
        avg: 10,
        min: 1,
        max: 20,
        last: 15,
        delta: 2,
        dataQuality: "good",
      }),
    ]);
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 0]],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: 3 * FIVE, // 0, 300k, 600k, 900k → 4 grid points (inclusive)
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.interval_end)).toEqual([
      0,
      FIVE,
      2 * FIVE,
      3 * FIVE,
    ]);
    // The populated grid point carries the values + data_quality...
    expect(rows[1]).toEqual({
      system_id: 1,
      point_id: 0,
      interval_end: FIVE,
      avg: 10,
      min: 1,
      max: 20,
      last: 15,
      delta: 2,
      data_quality: "good",
    });
    // ...gaps are all-null (dense fill).
    expect(rows[0]).toEqual({
      system_id: 1,
      point_id: 0,
      interval_end: 0,
      avg: null,
      min: null,
      max: null,
      last: null,
      delta: null,
      data_quality: null,
    });
  });

  it("5m: densifies an UNALIGNED range like the CTE (includes the first grid point ≥ lastEpoch)", async () => {
    register(1, 0);
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 0]],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: 250_000, // not on the 300k grid
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    // R+5min for every R < lastEpoch, so 0 (<250k) → 300k; 300k (≥250k) stops.
    expect(rows.map((r) => r.interval_end)).toEqual([0, FIVE]);
  });

  it("30m: uses the same 5-minute grid over the caller-supplied (pre-rolled) bounds", async () => {
    register(1, 0);
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 0]],
      interval: "30m",
      queryFirstEpoch: 0,
      lastEpoch: 2 * FIVE,
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.interval_end)).toEqual([0, FIVE, 2 * FIVE]);
  });

  it("5m: emits a dense grid per point", async () => {
    register(1, 0);
    register(1, 1);
    const out = await fetchAggRowsPg({
      uniquePairs: [
        [1, 0],
        [1, 1],
      ],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: FIVE, // 2 grid points per point
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4); // 2 points × 2 grid points
    expect(rows.filter((r) => r.point_id === 0)).toHaveLength(2);
    expect(rows.filter((r) => r.point_id === 1)).toHaveLength(2);
  });

  it("skips a pair with no registry identity (UnknownIdError) and keeps the rest", async () => {
    register(1, 0); // resolvable
    // (1, 1) is intentionally NOT registered → pointForAddr throws UnknownIdError → skip.
    const out = await fetchAggRowsPg({
      uniquePairs: [
        [1, 0],
        [1, 1],
      ],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: FIVE,
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.point_id === 0)).toHaveLength(2);
    expect(rows.filter((r) => r.point_id === 1)).toHaveLength(0); // dropped, not null-gridded
  });

  it("5m: reconstructs the avgCache from the sparse DAO rows (covered slice)", async () => {
    const pt = register(1, 0);
    read5mByPoint.set(pt, [
      agg5m(FIVE, { avg: 10 }),
      agg5m(2 * FIVE, { avg: 20 }),
    ]);
    const avgCache = new Agg5mAvgCache();
    await fetchAggRowsPg(
      {
        uniquePairs: [[1, 0]],
        interval: "5m",
        queryFirstEpoch: 0,
        lastEpoch: 2 * FIVE,
      },
      avgCache,
    );
    // The queried pair is covered and yields the raw sparse (t, avg) rows over the window.
    expect(avgCache.slice(1, 0, 0, 2 * FIVE)).toEqual({
      covered: true,
      from: 0,
      rows: [
        { t: FIVE, avg: 10 },
        { t: 2 * FIVE, avg: 20 },
      ],
    });
    // A pair fetch never queried is not covered → the consumer full-queries it.
    expect(avgCache.slice(1, 99, 0, 2 * FIVE)).toEqual({
      covered: false,
      from: 0,
      rows: [],
    });
  });
});
