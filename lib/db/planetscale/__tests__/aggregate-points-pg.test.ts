/**
 * Unit tests for the Postgres aggregation recompute orchestration
 * (lib/db/planetscale/aggregate-points-pg.ts).
 *
 * The per-point math is covered exhaustively in
 * lib/aggregation/__tests__/point-aggregates.test.ts; the DAO's own SQL in
 * lib/readings/__tests__/dao.test.ts. Here we pin the DB orchestration NOW ON THE DAO SEAM:
 *  - deriving the affected 5m intervals from raw observations,
 *  - grouping raw readings (current interval vs previous-interval previousLast), incl. the
 *    prevStart-boundary JS guard that reproduces the legacy half-open `(prevStart, intervalEnd]`,
 *  - the exact windows + args handed to ReadingsDao (readRaw/insert5m/read5m/upsert1d),
 *  - the value-only 5m upsert (`preserveVendorMeta`) and the per-system advisory lock.
 *
 * The readings seam is mocked: `ReadingsDao.readRaw/read5m` return canned per-point series keyed by
 * the real `PointId` (built from each point_info row's `point_uid` via the real codec), and
 * `insert5m/upsert1d` record their calls. A minimal fake `db` serves the `point_info` read and the
 * transaction/advisory-lock surface.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Point, type PointId } from "@/lib/ids";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import type { Observation } from "@/lib/observations/types";
import { CalendarDate } from "@internationalized/date";

const FIVE = 5 * 60 * 1000;

// ── mock the readings seam ──────────────────────────────────────────────────────────────────────
const mockReadRaw = jest.fn<(...args: any[]) => any>();
const mockRead5m = jest.fn<(...args: any[]) => any>();
const mockInsert5m = jest.fn<(...args: any[]) => any>();
const mockUpsert1d = jest.fn<(...args: any[]) => any>();
jest.mock("@/lib/readings", () => ({
  ReadingsDao: {
    readRaw: (...a: unknown[]) => mockReadRaw(...a),
    read5m: (...a: unknown[]) => mockRead5m(...a),
    insert5m: (...a: unknown[]) => mockInsert5m(...a),
    upsert1d: (...a: unknown[]) => mockUpsert1d(...a),
  },
}));
// mock the registry so UnknownIdError is a shared, side-effect-free class (no DB import).
jest.mock("@/lib/registry", () => ({
  UnknownIdError: class UnknownIdError extends Error {
    constructor(
      public kind: string,
      public id: string | number,
    ) {
      super(`unknown ${kind}: ${id}`);
      this.name = "UnknownIdError";
    }
  },
}));

import {
  affectedIntervalEndsMs,
  withSuccessorIntervals,
  recomputeAgg5mForIntervals,
  recomputeAgg1dForDay,
} from "../aggregate-points-pg";
import { UnknownIdError } from "@/lib/registry";

// Per-test canned data, keyed by PointId — the mocked reads seed every requested point (missing → []).
const cannedRaw = new Map<PointId, unknown[]>();
const cannedAgg5m = new Map<PointId, unknown[]>();

beforeEach(() => {
  cannedRaw.clear();
  cannedAgg5m.clear();
  mockReadRaw.mockReset();
  mockRead5m.mockReset();
  mockInsert5m.mockReset();
  mockUpsert1d.mockReset();
  mockReadRaw.mockImplementation(
    async (pids: PointId[]) =>
      new Map(pids.map((id) => [id, cannedRaw.get(id) ?? []])),
  );
  mockRead5m.mockImplementation(
    async (pids: PointId[]) =>
      new Map(pids.map((id) => [id, cannedAgg5m.get(id) ?? []])),
  );
  mockInsert5m.mockImplementation(async (rows: unknown[]) => ({
    written: rows.length,
  }));
  mockUpsert1d.mockImplementation(async (rows: unknown[]) => ({
    written: rows.length,
  }));
});

/** A point_info row with a real point_uid, plus the PointId the module will derive from it. */
function pointRow(transform: string | null, metricType: string) {
  const id = Point.generate();
  return { id, row: { pointUid: Point.toUuid(id), transform, metricType } };
}

/** Minimal fake db: `select().from().where()` → the canned point_info rows; tx + advisory lock. */
function makeFakeDb(pointInfoRows: unknown[]) {
  const executed: unknown[] = [];
  const db: Record<string, unknown> = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(pointInfoRows) }),
    }),
    execute: (q: unknown) => {
      executed.push(q);
      return Promise.resolve({ rows: [] });
    },
    transaction: (cb: (tx: unknown) => unknown) => Promise.resolve(cb(db)),
  };
  return { db, executed };
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
  it("acquires the per-system advisory lock and reads/writes on the tx handle", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const p1 = pointRow(null, "power");
    const { db, executed } = makeFakeDb([p1.row]);
    cannedRaw.set(p1.id, [{ measurementTimeMs: intervalEndMs, value: 5 }]);

    await recomputeAgg5mForIntervals(asDb(db), 7, [intervalEndMs]);

    // The recompute runs in a transaction whose only raw statement is the advisory lock.
    expect(executed).toHaveLength(1);
    expect(mockReadRaw).toHaveBeenCalled();
    expect(mockReadRaw.mock.calls[0][2]).toBe(db); // ran on the tx handle
    expect(mockInsert5m.mock.calls[0][2]).toBe(db);
  });

  it("computes per-point 5m from raw and upserts value-only rows via the DAO", async () => {
    const intervalEndMs = 1_700_000_400_000; // multiple of FIVE
    const intervalStartMs = intervalEndMs - FIVE;

    const p1 = pointRow(null, "power");
    const p2 = pointRow(null, "energy");
    const p3 = pointRow("d", "energy");
    const p4 = pointRow(null, "power");
    const { db } = makeFakeDb([p1.row, p2.row, p3.row, p4.row]);

    // p1 power: avg 20, min 10, max 30, last 30
    cannedRaw.set(p1.id, [
      { measurementTimeMs: intervalStartMs + 60_000, value: 10 },
      { measurementTimeMs: intervalStartMs + 120_000, value: 20 },
      { measurementTimeMs: intervalEndMs, value: 30 },
    ]);
    // p2 energy: avg 15, delta = sum = 45
    cannedRaw.set(p2.id, [
      { measurementTimeMs: intervalStartMs + 60_000, value: 5 },
      { measurementTimeMs: intervalStartMs + 120_000, value: 15 },
      { measurementTimeMs: intervalEndMs, value: 25 },
    ]);
    // p3 transform='d': prev reading at intervalStart=100; delta = 120 - 100 = 20
    cannedRaw.set(p3.id, [
      { measurementTimeMs: intervalStartMs, value: 100 },
      { measurementTimeMs: intervalStartMs + 60_000, value: 110 },
      { measurementTimeMs: intervalStartMs + 120_000, value: 120 },
    ]);
    // p4 power, all errors → sampleCount 0, errorCount 2
    cannedRaw.set(p4.id, [
      { measurementTimeMs: intervalStartMs + 60_000, value: null },
      { measurementTimeMs: intervalStartMs + 120_000, value: null },
    ]);

    const res = await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);
    expect(res).toEqual({ intervalsProcessed: 1, rowsUpserted: 4 });

    expect(mockInsert5m).toHaveBeenCalledTimes(1);
    const [rows, opts] = mockInsert5m.mock.calls[0];
    expect(opts).toEqual({ upsert: true, preserveVendorMeta: true });
    expect(rows).toEqual([
      {
        point: p1.id,
        intervalEndMs,
        avg: 20,
        min: 10,
        max: 30,
        last: 30,
        delta: null,
        valueStr: null,
        sampleCount: 3,
        errorCount: 0,
        dataQuality: null,
        sessionId: null,
      },
      {
        point: p2.id,
        intervalEndMs,
        avg: 15,
        min: 5,
        max: 25,
        last: 25,
        delta: 45,
        valueStr: null,
        sampleCount: 3,
        errorCount: 0,
        dataQuality: null,
        sessionId: null,
      },
      {
        point: p3.id,
        intervalEndMs,
        avg: null,
        min: null,
        max: null,
        last: 120,
        delta: 20,
        valueStr: null,
        sampleCount: 2,
        errorCount: 0,
        dataQuality: null,
        sessionId: null,
      },
      {
        point: p4.id,
        intervalEndMs,
        avg: null,
        min: null,
        max: null,
        last: null,
        delta: null,
        valueStr: null,
        sampleCount: 0,
        errorCount: 2,
        dataQuality: null,
        sessionId: null,
      },
    ]);

    // Reads the previous + current interval: [prevStart, intervalEnd] (JS guard drops == prevStart).
    expect(mockReadRaw.mock.calls[0][1]).toEqual({
      fromMs: intervalStartMs - FIVE,
      toMs: intervalEndMs,
    });
  });

  it("drops a reading exactly on prevStart (legacy gt(prevStart) bound) → delta stays null", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const intervalStartMs = intervalEndMs - FIVE;
    const prevStartMs = intervalStartMs - FIVE;
    const p = pointRow("d", "energy");
    const { db } = makeFakeDb([p.row]);
    // The reading exactly on prevStart must be ignored, leaving an empty previous interval → no
    // previousLast → delta null (matches the legacy half-open lower bound).
    cannedRaw.set(p.id, [
      { measurementTimeMs: prevStartMs, value: 100 },
      { measurementTimeMs: intervalStartMs + 60_000, value: 110 },
      { measurementTimeMs: intervalStartMs + 120_000, value: 120 },
    ]);
    await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);
    const [rows] = mockInsert5m.mock.calls[0];
    expect(rows[0]).toMatchObject({ point: p.id, last: 120, delta: null });
  });

  it("computes delta from a previousLast inside (prevStart, intervalStart]", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const intervalStartMs = intervalEndMs - FIVE;
    const p = pointRow("d", "energy");
    const { db } = makeFakeDb([p.row]);
    cannedRaw.set(p.id, [
      { measurementTimeMs: intervalStartMs, value: 100 }, // previous interval → prevLast 100
      { measurementTimeMs: intervalStartMs + 60_000, value: 110 },
      { measurementTimeMs: intervalStartMs + 120_000, value: 120 },
    ]);
    await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);
    const [rows] = mockInsert5m.mock.calls[0];
    expect(rows[0]).toMatchObject({ point: p.id, last: 120, delta: 20 });
  });

  it("does not create a row for a point present only in the previous interval", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const intervalStartMs = intervalEndMs - FIVE;
    const p9 = pointRow("d", "energy");
    const { db } = makeFakeDb([p9.row]);
    cannedRaw.set(p9.id, [
      { measurementTimeMs: intervalStartMs, value: 50 }, // only a previous-interval reading
    ]);
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);
    expect(res.rowsUpserted).toBe(0);
    expect(mockInsert5m).not.toHaveBeenCalled();
  });

  it("no-ops on an empty interval list (no tx, no DAO calls)", async () => {
    const { db, executed } = makeFakeDb([]);
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, []);
    expect(res).toEqual({ intervalsProcessed: 0, rowsUpserted: 0 });
    expect(executed).toHaveLength(0);
    expect(mockReadRaw).not.toHaveBeenCalled();
    expect(mockInsert5m).not.toHaveBeenCalled();
  });

  it("skips an interval when the DAO throws UnknownIdError, never throwing", async () => {
    const intervalEndMs = 1_700_000_400_000;
    const p = pointRow(null, "power");
    const { db } = makeFakeDb([p.row]);
    mockReadRaw.mockRejectedValueOnce(new UnknownIdError("point", "pt_x"));
    const res = await recomputeAgg5mForIntervals(asDb(db), 1, [intervalEndMs]);
    expect(res).toEqual({ intervalsProcessed: 1, rowsUpserted: 0 });
    expect(mockInsert5m).not.toHaveBeenCalled();
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

    const p1 = pointRow(null, "power");
    const { db } = makeFakeDb([p1.row]);
    cannedAgg5m.set(p1.id, [
      // Previous-day 00:00 interval → supplies `last`, not aggregated into the day.
      {
        intervalEndMs: prevEndMs,
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
        intervalEndMs: dayStartMs,
        avg: 10,
        min: 5,
        max: 15,
        last: 12,
        delta: 2,
        sampleCount: 3,
        errorCount: 0,
      },
      {
        intervalEndMs: dayStartMs + FIVE,
        avg: 20,
        min: 10,
        max: 30,
        last: 22,
        delta: 4,
        sampleCount: 3,
        errorCount: 1,
      },
      {
        intervalEndMs: dayEndMs,
        avg: 1,
        min: 1,
        max: 1,
        last: 1,
        delta: 1,
        sampleCount: 1,
        errorCount: 0,
      },
    ]);

    const res = await recomputeAgg1dForDay(
      asDb(db),
      { id: 1, timezoneOffsetMin: tz },
      day,
    );

    expect(res.rowsUpserted).toBe(1);
    expect(mockUpsert1d).toHaveBeenCalledTimes(1);
    const [rows, execArg] = mockUpsert1d.mock.calls[0];
    expect(execArg).toBe(db);
    const row = rows[0];
    expect(row.point).toBe(p1.id);
    expect(row.day).toBe("2026-01-15");
    expect(row.avg).toBeCloseTo((10 + 20 + 1) / 3, 10);
    expect(row.min).toBe(1);
    expect(row.max).toBe(30);
    expect(row.delta).toBe(2 + 4 + 1);
    expect(row.last).toBe(500); // from the previous-day 00:00 interval
    expect(row.sampleCount).toBe(3 + 3 + 1);
    expect(row.errorCount).toBe(1);

    // Read window inclusive at both ends (matches the legacy 1d bounds exactly).
    expect(mockRead5m.mock.calls[0][1]).toEqual({
      fromMs: prevEndMs,
      toMs: dayEndMs,
    });
  });

  it("no-ops when there is no PG 5m for the day", async () => {
    const day = new CalendarDate(2026, 1, 15);
    const p1 = pointRow(null, "power");
    const { db } = makeFakeDb([p1.row]); // cannedAgg5m empty → read5m returns [] for p1
    const res = await recomputeAgg1dForDay(
      asDb(db),
      { id: 1, timezoneOffsetMin: 600 },
      day,
    );
    expect(res.rowsUpserted).toBe(0);
    expect(mockUpsert1d).not.toHaveBeenCalled();
  });
});
