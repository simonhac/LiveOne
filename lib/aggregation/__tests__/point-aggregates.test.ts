/**
 * Unit tests for the shared, db-free aggregation math (lib/aggregation/point-aggregates.ts).
 *
 * These pin the EXACT semantics that both the Turso writers (updatePointAggregates5m,
 * aggregateDailyPointData) and the Postgres recompute (AGG_COMPUTE_IN_PG) rely on. Because
 * both engines call these helpers, equality here is what guarantees the value reconciler
 * (scripts/reconcile-agg-values.ts) can pass.
 */
import { describe, it, expect } from "@jest/globals";
import {
  aggregate5mForPoint,
  aggregate1dForPoint,
  intervalEndForMs,
  dayToUnixRangeForAggregation,
  FIVE_MIN_MS,
} from "../point-aggregates";
import { CalendarDate } from "@internationalized/date";

describe("aggregate5mForPoint", () => {
  it("power (no transform): avg/min/max/last, delta null", () => {
    expect(
      aggregate5mForPoint({
        values: [10, 20, 30],
        errorCount: 0,
        transform: null,
        metricType: "power",
      }),
    ).toEqual({
      avg: 20,
      min: 10,
      max: 30,
      last: 30,
      delta: null,
      sampleCount: 3,
      errorCount: 0,
    });
  });

  it("energy (no transform): delta = sum, plus avg/min/max/last", () => {
    expect(
      aggregate5mForPoint({
        values: [5, 15, 25],
        errorCount: 0,
        transform: null,
        metricType: "energy",
      }),
    ).toEqual({
      avg: 15,
      min: 5,
      max: 25,
      last: 25,
      delta: 45,
      sampleCount: 3,
      errorCount: 0,
    });
  });

  it("transform='d': delta = last − previousLast; avg/min/max null; last kept", () => {
    expect(
      aggregate5mForPoint({
        values: [110, 120],
        errorCount: 0,
        transform: "d",
        metricType: "energy",
        previousLast: 100,
      }),
    ).toEqual({
      avg: null,
      min: null,
      max: null,
      last: 120,
      delta: 20,
      sampleCount: 2,
      errorCount: 0,
    });
  });

  it("transform='d' with no previousLast: delta null (first interval / gap)", () => {
    const r = aggregate5mForPoint({
      values: [110, 120],
      errorCount: 0,
      transform: "d",
      metricType: "energy",
      previousLast: undefined,
    });
    expect(r.delta).toBeNull();
    expect(r.last).toBe(120);
    expect(r.avg).toBeNull();
  });

  it("transform='d' applies even for a non-energy metric (transform wins over metricType)", () => {
    const r = aggregate5mForPoint({
      values: [7, 9],
      errorCount: 0,
      transform: "d",
      metricType: "power",
      previousLast: 4,
    });
    expect(r).toEqual({
      avg: null,
      min: null,
      max: null,
      last: 9,
      delta: 5,
      sampleCount: 2,
      errorCount: 0,
    });
  });

  it("all readings errors: everything null, sampleCount 0, errorCount preserved", () => {
    expect(
      aggregate5mForPoint({
        values: [],
        errorCount: 3,
        transform: null,
        metricType: "power",
      }),
    ).toEqual({
      avg: null,
      min: null,
      max: null,
      last: null,
      delta: null,
      sampleCount: 0,
      errorCount: 3,
    });
  });

  it("mixed valid + errors: errorCount counts the nulls, aggregates over the valid", () => {
    const r = aggregate5mForPoint({
      values: [10, 30],
      errorCount: 2,
      transform: null,
      metricType: "power",
    });
    expect(r).toEqual({
      avg: 20,
      min: 10,
      max: 30,
      last: 30,
      delta: null,
      sampleCount: 2,
      errorCount: 2,
    });
  });

  it("single value: avg=min=max=last=value", () => {
    expect(
      aggregate5mForPoint({
        values: [42],
        errorCount: 0,
        transform: null,
        metricType: "soc",
      }),
    ).toEqual({
      avg: 42,
      min: 42,
      max: 42,
      last: 42,
      delta: null,
      sampleCount: 1,
      errorCount: 0,
    });
  });

  it("delta of zero is preserved (not coalesced to null) for transform='d'", () => {
    const r = aggregate5mForPoint({
      values: [100],
      errorCount: 0,
      transform: "d",
      metricType: "energy",
      previousLast: 100,
    });
    expect(r.delta).toBe(0);
  });
});

describe("aggregate1dForPoint", () => {
  it("rolls up 5m rows: mean of avgs, min of mins, max of maxs, sum of deltas, last passthrough", () => {
    const r = aggregate1dForPoint({
      rows: [
        { avg: 10, min: 5, max: 15, delta: 2, sampleCount: 3, errorCount: 0 },
        { avg: 20, min: 10, max: 30, delta: 4, sampleCount: 3, errorCount: 1 },
      ],
      last: 500,
    });
    expect(r).toEqual({
      avg: 15,
      min: 5,
      max: 30,
      last: 500,
      delta: 6,
      sampleCount: 6,
      errorCount: 1,
    });
  });

  it("ignores null fields when rolling up; all-null fields → null", () => {
    const r = aggregate1dForPoint({
      rows: [
        {
          avg: null,
          min: null,
          max: null,
          delta: 2,
          sampleCount: 1,
          errorCount: 0,
        },
        {
          avg: null,
          min: null,
          max: null,
          delta: 3,
          sampleCount: 1,
          errorCount: 0,
        },
      ],
      last: null,
    });
    expect(r).toEqual({
      avg: null,
      min: null,
      max: null,
      last: null,
      delta: 5,
      sampleCount: 2,
      errorCount: 0,
    });
  });

  it("empty rows → all values null, counts 0, last passthrough", () => {
    expect(aggregate1dForPoint({ rows: [], last: 7 })).toEqual({
      avg: null,
      min: null,
      max: null,
      last: 7,
      delta: null,
      sampleCount: 0,
      errorCount: 0,
    });
  });

  it("delta null when no row has a delta (e.g. non-energy day)", () => {
    const r = aggregate1dForPoint({
      rows: [
        { avg: 1, min: 1, max: 1, delta: null, sampleCount: 1, errorCount: 0 },
      ],
      last: 1,
    });
    expect(r.delta).toBeNull();
  });
});

describe("intervalEndForMs", () => {
  it("a reading mid-interval rounds up to the interval end", () => {
    // 20:31:00 → interval ending 20:35:00
    const t = Date.parse("2026-01-15T20:31:00Z");
    expect(intervalEndForMs(t)).toBe(Date.parse("2026-01-15T20:35:00Z"));
  });

  it("a reading exactly on a boundary belongs to that boundary (inclusive end)", () => {
    const t = Date.parse("2026-01-15T20:35:00Z");
    expect(intervalEndForMs(t)).toBe(t);
  });

  it("FIVE_MIN_MS is five minutes", () => {
    expect(FIVE_MIN_MS).toBe(5 * 60 * 1000);
  });
});

describe("dayToUnixRangeForAggregation", () => {
  it("AEST (+600): 00:05 of the day to 00:00 of the next day", () => {
    const [startUnix, endUnix] = dayToUnixRangeForAggregation(
      new CalendarDate(2026, 1, 15),
      600,
    );
    // 2026-01-15 00:05:00 +10:00  and  2026-01-16 00:00:00 +10:00
    expect(startUnix * 1000).toBe(Date.parse("2026-01-15T00:05:00+10:00"));
    expect(endUnix * 1000).toBe(Date.parse("2026-01-16T00:00:00+10:00"));
    // The window is exactly 287 five-minute steps wide (00:05 .. 00:00 next day).
    expect((endUnix - startUnix) * 1000).toBe(287 * FIVE_MIN_MS);
  });

  it("UTC (0): aligns to the UTC day", () => {
    const [startUnix, endUnix] = dayToUnixRangeForAggregation(
      new CalendarDate(2026, 6, 1),
      0,
    );
    expect(startUnix * 1000).toBe(Date.parse("2026-06-01T00:05:00Z"));
    expect(endUnix * 1000).toBe(Date.parse("2026-06-02T00:00:00Z"));
  });

  it("positive fractional offset (+330 → +05:30)", () => {
    const [startUnix] = dayToUnixRangeForAggregation(
      new CalendarDate(2026, 6, 1),
      330,
    );
    expect(startUnix * 1000).toBe(Date.parse("2026-06-01T00:05:00+05:30"));
  });

  it("negative fractional offset (-210 → -03:30, not -04:30)", () => {
    // Regression: Math.floor(-210/60) = -4 would have produced -04:30.
    const [startUnix, endUnix] = dayToUnixRangeForAggregation(
      new CalendarDate(2026, 6, 1),
      -210,
    );
    expect(startUnix * 1000).toBe(Date.parse("2026-06-01T00:05:00-03:30"));
    expect(endUnix * 1000).toBe(Date.parse("2026-06-02T00:00:00-03:30"));
  });
});
