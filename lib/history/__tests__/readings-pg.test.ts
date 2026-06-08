import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// fetchAggRowsPg reads the `planetscaleDb` singleton; expose a mutable mock via a getter.
let mockDb: unknown = null;
jest.mock("@/lib/db/planetscale", () => ({
  get planetscaleDb() {
    return mockDb;
  },
}));

import { fetchAggRowsPg, compareHistorySeries } from "../readings-pg";
import {
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/planetscale/schema";
import { SHADOW_SKIP } from "@/lib/db/readings-shadow";
import type { OpenNEMDataSeries } from "@/types/opennem";

const FIVE = 5 * 60 * 1000;

/**
 * Minimal fake of the drizzle node-postgres surface fetchAggRowsPg touches:
 * select(cols).from(table).where(cond) resolving to canned rows, keyed by table. The WHERE
 * predicate (real drizzle SQL) is ignored — we pin the densify/mapping logic, not the predicate
 * (its correctness is proven against a real DB by scripts/reconcile-agg-values.ts).
 */
function makeFakeDb(byTable: { agg5m?: unknown[]; agg1d?: unknown[] }) {
  let fromCalls = 0;
  const db = {
    select() {
      return {
        from(table: unknown) {
          fromCalls++;
          const rows =
            table === pointReadingsAgg5m
              ? (byTable.agg5m ?? [])
              : table === pointReadingsAgg1d
                ? (byTable.agg1d ?? [])
                : [];
          // `where()` is awaited directly by the 5m/30m path and chained with `.orderBy()` by the
          // 1d path — return a thenable that supports both (the canned rows are order-agnostic).
          return {
            where: () =>
              Object.assign(Promise.resolve(rows), {
                orderBy: () => Promise.resolve(rows),
              }),
          };
        },
      };
    },
  };
  return { db, fromCalls: () => fromCalls };
}

const setDb = (db: unknown) => {
  mockDb = db;
};

beforeEach(() => {
  mockDb = null;
});

describe("fetchAggRowsPg", () => {
  it("returns SHADOW_SKIP when Postgres is unconfigured", async () => {
    mockDb = null;
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 0]],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: FIVE,
    });
    expect(out).toBe(SHADOW_SKIP);
  });

  it("1d: maps day rows and emits data_quality:null (PG agg_1d has no such column)", async () => {
    const { db } = makeFakeDb({
      agg1d: [
        {
          systemId: 1,
          pointId: 7,
          day: "2026-01-15",
          avg: 1.5,
          min: 0,
          max: 3,
          last: 2,
          delta: 9,
        },
      ],
    });
    setDb(db);
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

  it("5m: densifies an ALIGNED range to the exact CTE grid, mapping Date→epoch-ms", async () => {
    // Sparse: only the 300k interval has data; the rest must come back as null gap rows.
    const { db } = makeFakeDb({
      agg5m: [
        {
          pointId: 0,
          intervalEnd: new Date(300_000),
          avg: 10,
          min: 1,
          max: 20,
          last: 15,
          delta: 2,
          dataQuality: "good",
        },
      ],
    });
    setDb(db);
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 0]],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: 3 * FIVE, // 0, 300k, 600k, 900k → 4 grid points (inclusive)
    });
    expect(out).not.toBe(SHADOW_SKIP);
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
    const { db } = makeFakeDb({ agg5m: [] });
    setDb(db);
    const out = await fetchAggRowsPg({
      uniquePairs: [[1, 0]],
      interval: "5m",
      queryFirstEpoch: 0,
      lastEpoch: 250_000, // not on the 300k grid
    });
    const rows = out as unknown as Array<Record<string, unknown>>;
    // CTE generates R+5min for every R < lastEpoch, so 0 (<250k) → 300k; 300k (≥250k) stops.
    expect(rows.map((r) => r.interval_end)).toEqual([0, FIVE]);
  });

  it("30m: uses the same 5-minute grid over the caller-supplied (pre-rolled) bounds", async () => {
    const { db } = makeFakeDb({ agg5m: [] });
    setDb(db);
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
    const { db } = makeFakeDb({ agg5m: [] });
    setDb(db);
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
});

describe("compareHistorySeries", () => {
  const series = (
    id: string,
    data: (number | string | null)[],
  ): OpenNEMDataSeries => ({
    id,
    type: "power",
    units: "W",
    path: `${id}.avg`,
    history: {
      firstInterval: "2026-01-15T00:00:00+10:00",
      lastInterval: "2026-01-15T00:10:00+10:00",
      interval: "5m",
      numIntervals: data.length,
      data,
    },
  });

  it("matches identical series", () => {
    const a = [series("s1", [1, 2, 3])];
    const b = [series("s1", [1, 2, 3])];
    expect(compareHistorySeries(a, b)).toEqual({ matched: true });
  });

  it("matches within float tolerance", () => {
    const a = [series("s1", [1.0, 2.0])];
    const b = [series("s1", [1.0 + 1e-9, 2.0])];
    expect(compareHistorySeries(a, b).matched).toBe(true);
  });

  it("flags two present values that differ beyond tolerance", () => {
    const r = compareHistorySeries(
      [series("s1", [1, 2, 3])],
      [series("s1", [1, 9, 3])],
    );
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("s1[1]");
    expect(r.detail).toContain("turso=2 pg=9");
  });

  it("does NOT flag live-tail lag (Turso has a value where PG is null)", () => {
    const r = compareHistorySeries(
      [series("s1", [1, 2, 3])],
      [series("s1", [1, 2, null])], // PG hasn't ingested the newest interval yet
    );
    expect(r).toEqual({ matched: true });
  });

  it("does NOT flag 1d quality (PG null) against a Turso string", () => {
    const r = compareHistorySeries(
      [series("s1.quality", ["good", "good"])],
      [series("s1.quality", [null, null])],
    );
    expect(r).toEqual({ matched: true });
  });

  it("flags a series present on only one side", () => {
    const r = compareHistorySeries(
      [series("s1", [1]), series("s2", [2])],
      [series("s1", [1])],
    );
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("s2: present only in turso");
  });

  it("notes a numIntervals mismatch", () => {
    const r = compareHistorySeries(
      [series("s1", [1, 2, 3])],
      [series("s1", [1, 2])],
    );
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("numIntervals turso=3 pg=2");
  });
});
