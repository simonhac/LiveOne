import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Point, type PointId } from "@/lib/ids";
import type { Agg5mReading, Agg1dReading } from "@/lib/readings";

/**
 * After the config-v4 readings-seam migration `fetchAggRowsPg` is a pure transform over
 * `ReadingsDao` output: it reads by the `PointId` the CALLER supplies, then densifies (5m/30m) /
 * maps (1d) and reconstructs the `avgCache`. These tests pin that transform against a mocked DAO —
 * the DAO's own SQL/WHERE is proven separately in `lib/readings/__tests__/dao.test.ts`.
 *
 * There is no registry mock any more: slice D moved identity resolution up to the caller
 * (`SeriesInfo.point` / `LogicalSystemPoint` both carry `point_uid`), so this module no longer
 * resolves an address at all. Its absence here is part of what the suite asserts.
 */

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

import { fetchAggRowsPg, type AggFetchPoint } from "../readings-pg";
import { Agg5mAvgCache } from "../agg5m-cache";

const FIVE = 5 * 60 * 1000;

/**
 * A point to fetch, as the caller now supplies it: the identity to read by, plus the composite
 * address the SERVED rows are re-keyed on. Deliberately unrelated values — nothing derives one
 * from the other any more.
 */
function pair(systemId: number, index: number): AggFetchPoint {
  return { point: Point.generate(), systemId, pointId: index };
}

function agg5m(intervalEndMs: number, v: Partial<Agg5mReading>): Agg5mReading {
  return {
    intervalEndMs,
    createdAtMs: 0,
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
  read5mByPoint.clear();
  read1dByPoint.clear();
});

describe("fetchAggRowsPg", () => {
  it("1d: maps day rows and emits data_quality:null (PG agg_1d has no such column)", async () => {
    const p = pair(1, 7);
    read1dByPoint.set(p.point, [
      agg1d("2026-01-15", { avg: 1.5, min: 0, max: 3, last: 2, delta: 9 }),
    ]);
    const out = await fetchAggRowsPg({
      uniquePairs: [p],
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
    const p = pair(1, 0);
    read5mByPoint.set(p.point, [
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
      uniquePairs: [p],
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
    const out = await fetchAggRowsPg({
      uniquePairs: [pair(1, 0)],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: 250_000, // not on the 300k grid
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    // R+5min for every R < lastEpoch, so 0 (<250k) → 300k; 300k (≥250k) stops.
    expect(rows.map((r) => r.interval_end)).toEqual([0, FIVE]);
  });

  it("30m: uses the same 5-minute grid over the caller-supplied (pre-rolled) bounds", async () => {
    const out = await fetchAggRowsPg({
      uniquePairs: [pair(1, 0)],
      interval: "30m",
      queryFirstEpoch: 0,
      lastEpoch: 2 * FIVE,
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.interval_end)).toEqual([0, FIVE, 2 * FIVE]);
  });

  it("5m: emits a dense grid per point", async () => {
    const out = await fetchAggRowsPg({
      uniquePairs: [pair(1, 0), pair(1, 1)],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: FIVE, // 2 grid points per point
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4); // 2 points × 2 grid points
    expect(rows.filter((r) => r.point_id === 0)).toHaveLength(2);
    expect(rows.filter((r) => r.point_id === 1)).toHaveLength(2);
  });

  // Replaces "skips a pair with no registry identity (UnknownIdError)". That branch is GONE with
  // the address lookup (config-v4 Phase 12 slice D): `point_uid` is NOT NULL and the caller read
  // the row, so an unresolvable point is no longer representable here. What matters instead is
  // that the two halves are genuinely decoupled — the DAO is read by the caller's identity, and
  // the served rows are keyed by the caller's integer index, with nothing deriving one from the
  // other. This test would have been impossible under the old lookup.
  it("reads by the caller's identity and re-keys the served rows on the caller's index", async () => {
    const p = pair(1, 42);
    read5mByPoint.set(p.point, [agg5m(FIVE, { avg: 10 })]);
    const out = await fetchAggRowsPg({
      uniquePairs: [p],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: FIVE,
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2); // dense grid: 0, FIVE
    expect(rows.every((r) => r.point_id === 42)).toBe(true);
    expect(rows.find((r) => r.interval_end === FIVE)!.avg).toBe(10);
  });

  it("5m: reconstructs the avgCache from the sparse DAO rows (covered slice)", async () => {
    const p = pair(1, 0);
    read5mByPoint.set(p.point, [
      agg5m(FIVE, { avg: 10 }),
      agg5m(2 * FIVE, { avg: 20 }),
    ]);
    const avgCache = new Agg5mAvgCache();
    await fetchAggRowsPg(
      {
        uniquePairs: [p],
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
