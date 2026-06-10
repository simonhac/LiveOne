/**
 * Unit tests for the Postgres aggregation recompute orchestration
 * (lib/db/planetscale/aggregate-points-pg.ts).
 *
 * The per-point math is covered exhaustively in
 * lib/aggregation/__tests__/point-aggregates.test.ts; here we pin the DB orchestration:
 *  - deriving the affected 5m intervals from raw observations,
 *  - grouping raw readings (current interval vs previous-interval previousLast),
 *  - the upserted row shapes for both 5m and 1d.
 *
 * A minimal fake `db` stands in for the drizzle node-postgres surface the recompute
 * touches: select(cols).from(table).where(cond)[.orderBy(...)] resolving to canned rows,
 * and insert(table).values(rows).onConflictDoUpdate(cfg) recording the upsert.
 */
import { describe, it, expect } from "@jest/globals";
import {
  affectedIntervalEndsMs,
  withSuccessorIntervals,
  recomputeAgg5mForIntervals,
  recomputeAgg1dForDay,
} from "../aggregate-points-pg";
import {
  pointInfo,
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "../schema";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import type { Observation } from "@/lib/observations/types";
import { CalendarDate } from "@internationalized/date";

const FIVE = 5 * 60 * 1000;

function tableName(t: unknown): string {
  if (t === pointInfo) return "point_info";
  if (t === pointReadings) return "point_readings";
  if (t === pointReadingsAgg5m) return "point_readings_agg_5m";
  if (t === pointReadingsAgg1d) return "point_readings_agg_1d";
  return "unknown";
}

interface Canned {
  point_info?: unknown[];
  point_readings?: unknown[];
  point_readings_agg_5m?: unknown[];
}

function makeFakeDb(canned: Canned) {
  const upserts: { table: string; rows: any[] }[] = [];
  // Raw SQL executed (e.g. the per-system advisory lock) — recorded so tests can assert it.
  const executed: unknown[] = [];

  function makeQuery(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      orderBy: () => Promise.resolve(rows),
      then: (onF: any, onR: any) => p.then(onF, onR),
      catch: (onR: any) => p.catch(onR),
      finally: (onF: any) => p.finally(onF),
    };
  }

  const db = {
    select() {
      return {
        from(table: unknown) {
          const name = tableName(table);
          const rows = (canned as Record<string, unknown[]>)[name] ?? [];
          return { where: () => makeQuery(rows) };
        },
      };
    },
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(rows: any[]) {
          return {
            onConflictDoUpdate() {
              upserts.push({ table: name, rows });
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    // recomputeAgg5mForIntervals wraps its work in a transaction guarded by an advisory lock.
    execute(q: unknown) {
      executed.push(q);
      return Promise.resolve({ rows: [] });
    },
    transaction(cb: (tx: unknown) => unknown) {
      // The transaction handle is the same fake surface (select/insert/execute).
      return Promise.resolve(cb(db));
    },
  };

  return { db, upserts, executed };
}

const asDb = (db: unknown) =>
  db as unknown as Parameters<typeof recomputeAgg5mForIntervals>[0];

describe("affectedIntervalEndsMs", () => {
  function obs(measurementTime: string): Observation {
    return {
      sessionId: "s",
      topic: "t",
      measurementTime,
      receivedTime: measurementTime,
      value: 1,
      interval: "raw",
    };
  }

  it("maps readings to distinct, ascending 5m interval ends", () => {
    const result = affectedIntervalEndsMs([
      obs("2026-01-15T20:36:00+10:00"), // → 20:40
      obs("2026-01-15T20:31:00+10:00"), // → 20:35
      obs("2026-01-15T20:33:00+10:00"), // → 20:35 (dup)
    ]);
    expect(result).toEqual([
      Date.parse("2026-01-15T20:35:00+10:00"),
      Date.parse("2026-01-15T20:40:00+10:00"),
    ]);
  });

  it("skips unparseable timestamps and returns [] for none", () => {
    expect(affectedIntervalEndsMs([])).toEqual([]);
    expect(affectedIntervalEndsMs([obs("not-a-date")])).toEqual([]);
  });
});

describe("withSuccessorIntervals", () => {
  it("adds each interval's immediate successor (end + 5min), deduped + ascending", () => {
    const e = Date.parse("2026-01-15T20:35:00+10:00");
    expect(withSuccessorIntervals([e])).toEqual([e, e + FIVE]);
  });

  it("dedupes where a touched interval is another's successor", () => {
    const e = Date.parse("2026-01-15T20:35:00+10:00");
    // [N, N+1] → {N, N+1, N+2} (N+1 is both touched and N's successor → not duplicated)
    expect(withSuccessorIntervals([e, e + FIVE])).toEqual([
      e,
      e + FIVE,
      e + 2 * FIVE,
    ]);
  });

  it("returns [] for none", () => {
    expect(withSuccessorIntervals([])).toEqual([]);
  });
});

describe("recomputeAgg5mForIntervals", () => {
  it("acquires the per-system advisory lock before recomputing (order-safety)", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const { db, executed } = makeFakeDb({
      point_info: [{ index: 1, transform: null, metricType: "power" }],
      point_readings: [
        { pointId: 1, measurementTime: new Date(intervalEndMs), value: 5 },
      ],
    });
    await recomputeAgg5mForIntervals(asDb(db), 7, [intervalEndMs]);
    // The recompute runs in a transaction whose only raw statement is the advisory lock.
    expect(executed).toHaveLength(1);
  });

  it("computes per-point 5m from raw and upserts the expected rows", async () => {
    const intervalEndMs = 1_700_000_400_000; // multiple of FIVE
    const intervalStartMs = intervalEndMs - FIVE;

    const canned: Canned = {
      point_info: [
        { index: 1, transform: null, metricType: "power" },
        { index: 2, transform: null, metricType: "energy" },
        { index: 3, transform: "d", metricType: "energy" },
        { index: 4, transform: null, metricType: "power" },
      ],
      // Ordered by (pointId asc, measurementTime asc), as the real query returns.
      point_readings: [
        // p1 power: avg 20, min 10, max 30, last 30
        {
          pointId: 1,
          measurementTime: new Date(intervalStartMs + 60_000),
          value: 10,
        },
        {
          pointId: 1,
          measurementTime: new Date(intervalStartMs + 120_000),
          value: 20,
        },
        { pointId: 1, measurementTime: new Date(intervalEndMs), value: 30 },
        // p2 energy: avg 15, delta = sum = 45
        {
          pointId: 2,
          measurementTime: new Date(intervalStartMs + 60_000),
          value: 5,
        },
        {
          pointId: 2,
          measurementTime: new Date(intervalStartMs + 120_000),
          value: 15,
        },
        { pointId: 2, measurementTime: new Date(intervalEndMs), value: 25 },
        // p3 transform='d': prev reading at intervalStart=100; delta = 120 - 100 = 20
        { pointId: 3, measurementTime: new Date(intervalStartMs), value: 100 },
        {
          pointId: 3,
          measurementTime: new Date(intervalStartMs + 60_000),
          value: 110,
        },
        {
          pointId: 3,
          measurementTime: new Date(intervalStartMs + 120_000),
          value: 120,
        },
        // p4 power, all errors → sampleCount 0, errorCount 2
        {
          pointId: 4,
          measurementTime: new Date(intervalStartMs + 60_000),
          value: null,
        },
        {
          pointId: 4,
          measurementTime: new Date(intervalStartMs + 120_000),
          value: null,
        },
      ],
    };

    const { db, upserts } = makeFakeDb(canned);
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);

    expect(res).toEqual({ intervalsProcessed: 1, rowsUpserted: 4 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe("point_readings_agg_5m");
    expect(upserts[0].rows).toEqual([
      {
        systemId: 1,
        pointId: 1,
        intervalEnd: new Date(intervalEndMs),
        avg: 20,
        min: 10,
        max: 30,
        last: 30,
        delta: null,
        sampleCount: 3,
        errorCount: 0,
      },
      {
        systemId: 1,
        pointId: 2,
        intervalEnd: new Date(intervalEndMs),
        avg: 15,
        min: 5,
        max: 25,
        last: 25,
        delta: 45,
        sampleCount: 3,
        errorCount: 0,
      },
      {
        systemId: 1,
        pointId: 3,
        intervalEnd: new Date(intervalEndMs),
        avg: null,
        min: null,
        max: null,
        last: 120,
        delta: 20,
        sampleCount: 2,
        errorCount: 0,
      },
      {
        systemId: 1,
        pointId: 4,
        intervalEnd: new Date(intervalEndMs),
        avg: null,
        min: null,
        max: null,
        last: null,
        delta: null,
        sampleCount: 0,
        errorCount: 2,
      },
    ]);
  });

  it("does not create a row for a point present only in the previous interval", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const intervalStartMs = intervalEndMs - FIVE;
    const canned: Canned = {
      point_info: [{ index: 9, transform: "d", metricType: "energy" }],
      point_readings: [
        // Only a previous-interval reading; nothing in the current interval.
        { pointId: 9, measurementTime: new Date(intervalStartMs), value: 50 },
      ],
    };
    const { db, upserts } = makeFakeDb(canned);
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);
    expect(res.rowsUpserted).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("no-ops on an empty interval list", async () => {
    const { db, upserts } = makeFakeDb({});
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, []);
    expect(res).toEqual({ intervalsProcessed: 0, rowsUpserted: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("skips a point present in raw but absent from the PG point_info mirror (avoids wrong metadata)", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const intervalStartMs = intervalEndMs - FIVE;
    const canned: Canned = {
      // point_info has point 1 but NOT point 2.
      point_info: [{ index: 1, transform: null, metricType: "power" }],
      point_readings: [
        {
          pointId: 1,
          measurementTime: new Date(intervalStartMs + 60_000),
          value: 10,
        },
        // point 2 has a current reading but no point_info → must be skipped, not defaulted.
        {
          pointId: 2,
          measurementTime: new Date(intervalStartMs + 60_000),
          value: 99,
        },
      ],
    };
    const { db, upserts } = makeFakeDb(canned);
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);

    expect(res.rowsUpserted).toBe(1); // only point 1
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows.map((r: any) => r.pointId)).toEqual([1]);
  });
});

describe("recomputeAgg1dForDay", () => {
  it("rolls PG 5m into a 1d row, taking last from the previous-day 00:00 interval", async () => {
    const day = new CalendarDate(2026, 1, 15);
    const tz = 600;
    const [startUnix, endUnix] = dayToUnixRangeForAggregation(day, tz);
    const dayStartMs = startUnix * 1000;
    const dayEndMs = endUnix * 1000;
    const prevEndMs = dayStartMs - FIVE;

    const canned: Canned = {
      point_readings_agg_5m: [
        // Previous-day 00:00 interval → supplies `last`, not aggregated into the day.
        {
          pointId: 1,
          intervalEnd: new Date(prevEndMs),
          avg: 999,
          min: 999,
          max: 999,
          last: 500,
          delta: 9,
          sampleCount: 1,
          errorCount: 0,
        },
        // Two in-day intervals + the inclusive end (00:00 next day).
        {
          pointId: 1,
          intervalEnd: new Date(dayStartMs),
          avg: 10,
          min: 5,
          max: 15,
          last: 12,
          delta: 2,
          sampleCount: 3,
          errorCount: 0,
        },
        {
          pointId: 1,
          intervalEnd: new Date(dayStartMs + FIVE),
          avg: 20,
          min: 10,
          max: 30,
          last: 22,
          delta: 4,
          sampleCount: 3,
          errorCount: 1,
        },
        {
          pointId: 1,
          intervalEnd: new Date(dayEndMs),
          avg: 1,
          min: 1,
          max: 1,
          last: 1,
          delta: 1,
          sampleCount: 1,
          errorCount: 0,
        },
      ],
    };

    const { db, upserts } = makeFakeDb(canned);
    const res = await recomputeAgg1dForDay(
      asDb(db),
      { id: 1, timezoneOffsetMin: tz },
      day,
    );

    expect(res.rowsUpserted).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe("point_readings_agg_1d");
    const row = upserts[0].rows[0];
    expect(row.systemId).toBe(1);
    expect(row.pointId).toBe(1);
    expect(row.day).toBe("2026-01-15");
    expect(row.avg).toBeCloseTo((10 + 20 + 1) / 3, 10);
    expect(row.min).toBe(1);
    expect(row.max).toBe(30);
    expect(row.delta).toBe(2 + 4 + 1);
    expect(row.last).toBe(500); // from the previous-day 00:00 interval
    expect(row.sampleCount).toBe(3 + 3 + 1);
    expect(row.errorCount).toBe(1);
  });

  it("no-ops when there is no PG 5m for the day", async () => {
    const day = new CalendarDate(2026, 1, 15);
    const { db, upserts } = makeFakeDb({ point_readings_agg_5m: [] });
    const res = await recomputeAgg1dForDay(
      asDb(db),
      { id: 1, timezoneOffsetMin: 600 },
      day,
    );
    expect(res.rowsUpserted).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});
