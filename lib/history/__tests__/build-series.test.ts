import { describe, it, expect, jest } from "@jest/globals";

// Decouple from SeriesPath/identifier internals and the config registry: getSeriesPath → a simple
// id, `deviceByHandle` → present for all devices except 999 (to test the skip path).
jest.mock("@/lib/point/series-info", () => ({
  getSeriesPath: (s: {
    point: { index: number };
    aggregationField: string;
  }) => ({
    toString: () => `${s.point.index}/${s.aggregationField}`,
  }),
}));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: async (id: number) => (id === 999 ? null : { id }),
  },
}));

import { buildSeriesFromAggRows, type AggRow } from "../build-series";
import type { SeriesInfo } from "@/lib/point/series-info";

const FIVE = 5 * 60 * 1000;
const device = { timezoneOffsetMin: 600 } as any;

function fakePoint(opts: {
  index: number;
  systemId: number;
  transform?: string | null;
  metricType?: string;
  metricUnit?: string;
  name?: string;
  logicalPath?: string | null;
}) {
  return {
    index: opts.index,
    systemId: opts.systemId,
    transform: opts.transform ?? null,
    metricType: opts.metricType ?? "power",
    metricUnit: opts.metricUnit ?? "W",
    name: opts.name ?? "P",
    getLogicalPath: () => opts.logicalPath ?? null,
  };
}

function seriesInfo(
  point: ReturnType<typeof fakePoint>,
  aggregationField: string,
): SeriesInfo {
  return {
    systemIdentifier: {} as any,
    point: point as any,
    aggregationField,
    intervals: ["5m"],
  };
}

describe("buildSeriesFromAggRows", () => {
  it("5m: builds one dense series, applies toPrecision(4)", async () => {
    const point = fakePoint({ index: 5, systemId: 1, metricType: "power" });
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 5, interval_end: FIVE, avg: 10 },
      { system_id: 1, point_id: 5, interval_end: 2 * FIVE, avg: 1.23456 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "avg")],
      "5m",
      device,
      FIVE,
      2 * FIVE,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("5/avg");
    expect(out[0].path).toBe("5/power.avg"); // no logical path → index/metricType
    expect(out[0].units).toBe("W");
    expect(out[0].history.numIntervals).toBe(2);
    expect(out[0].history.data).toEqual([10, 1.235]); // 1.23456 → toPrecision(4)
  });

  it("applies the invert transform ('i') to numeric values", async () => {
    const point = fakePoint({ index: 3, systemId: 1, transform: "i" });
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 3, interval_end: FIVE, avg: 10 },
      { system_id: 1, point_id: 3, interval_end: 2 * FIVE, avg: null },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "avg")],
      "5m",
      device,
      FIVE,
      2 * FIVE,
    );
    expect(out[0].history.data).toEqual([-10, null]);
  });

  it("passes a quality (string) series through unchanged", async () => {
    const point = fakePoint({ index: 4, systemId: 1 });
    const allRows: AggRow[] = [
      {
        system_id: 1,
        point_id: 4,
        interval_end: FIVE,
        data_quality: "good",
      },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "quality")],
      "5m",
      device,
      FIVE,
      FIVE,
    );
    expect(out[0].history.data).toEqual(["good"]);
  });

  it("30m: averages numeric 5m readings into request-aligned buckets", async () => {
    const point = fakePoint({ index: 1, systemId: 1 });
    // firstEpoch 0, 30m bucket = 1.8M ms; all three readings fall in bucket ending 1.8M.
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 1, interval_end: FIVE, avg: 10 },
      { system_id: 1, point_id: 1, interval_end: 2 * FIVE, avg: 20 },
      { system_id: 1, point_id: 1, interval_end: 3 * FIVE, avg: 30 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "avg")],
      "30m",
      device,
      0,
      30 * 60 * 1000,
    );
    expect(out[0].history.data).toEqual([20]); // (10+20+30)/3
  });

  it("30m: reduces each aggregation field by its own semantics", async () => {
    // One point with six 5m rows carrying delta/min/max/last; four series over the
    // same rows. delta must SUM (the 6×-too-small bug), min/max take the extreme,
    // last takes the most recent non-null value — never the mean.
    const point = fakePoint({ index: 6, systemId: 1, metricType: "energy" });
    const allRows: AggRow[] = [1, 2, 3, 4, 5, 6].map((i) => ({
      system_id: 1,
      point_id: 6,
      interval_end: i * FIVE,
      delta: 0.5,
      min: 7 - i, // mins 6..1 → bucket min 1
      max: i * 10, // maxes 10..60 → bucket max 60
      last: i * 100, // lasts 100..600 → bucket last 600
    }));
    const fields = ["delta", "min", "max", "last"] as const;
    const out = await buildSeriesFromAggRows(
      allRows,
      fields.map((f) => seriesInfo(point, f)),
      "30m",
      device,
      0,
      30 * 60 * 1000,
    );
    const byField = Object.fromEntries(fields.map((f, i) => [f, out[i]]));
    expect(byField.delta.history.data).toEqual([3]); // 6 × 0.5 summed, not averaged
    expect(byField.min.history.data).toEqual([1]);
    expect(byField.max.history.data).toEqual([60]);
    expect(byField.last.history.data).toEqual([600]);
  });

  it("30m: delta sum is invariant across bucketing (sum of 30m == sum of 5m)", async () => {
    // Two 30m buckets, ragged values, one null row — the total energy served at 30m
    // must equal the total of the underlying 5m deltas.
    const point = fakePoint({ index: 7, systemId: 1, metricType: "energy" });
    const deltas = [
      0.1,
      0.25,
      null,
      0.4,
      0.05,
      0.2,
      0.3,
      null,
      0.15,
      0.1,
      0.5,
      0.05,
    ];
    const allRows: AggRow[] = deltas.map((d, i) => ({
      system_id: 1,
      point_id: 7,
      interval_end: (i + 1) * FIVE,
      delta: d,
    }));
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "delta")],
      "30m",
      device,
      0,
      60 * 60 * 1000,
    );
    const sum30m = (out[0].history.data as (number | null)[]).reduce<number>(
      (s, v) => s + (v ?? 0),
      0,
    );
    const sum5m = deltas.reduce<number>((s, v) => s + (v ?? 0), 0);
    expect(sum30m).toBeCloseTo(sum5m, 10);
    expect(out[0].history.data).toEqual([1, 1.1]);
  });

  it("30m: a bucket with only null rows yields null, and 'last' skips trailing nulls", async () => {
    const point = fakePoint({ index: 10, systemId: 1, metricType: "soc" });
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 10, interval_end: FIVE, last: 55 },
      { system_id: 1, point_id: 10, interval_end: 2 * FIVE, last: 60 },
      { system_id: 1, point_id: 10, interval_end: 3 * FIVE, last: null },
      // second bucket: all null
      { system_id: 1, point_id: 10, interval_end: 7 * FIVE, last: null },
      { system_id: 1, point_id: 10, interval_end: 8 * FIVE, last: null },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "last")],
      "30m",
      device,
      0,
      60 * 60 * 1000,
    );
    expect(out[0].history.data).toEqual([60, null]);
  });

  it("1d: builds a series from day rows", async () => {
    const point = fakePoint({ index: 2, systemId: 1, metricType: "energy" });
    const dayMs = new Date("2026-01-15T00:00:00Z").getTime();
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 2, day: "2026-01-15", delta: 42 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "delta")],
      "1d",
      device,
      dayMs,
      dayMs,
    );
    expect(out[0].id).toBe("2/delta");
    expect(out[0].history.data).toEqual([42]);
  });

  it("1d: orders day rows by day regardless of input row order", async () => {
    const point = fakePoint({ index: 8, systemId: 1, metricType: "power" });
    const d = (s: string) => new Date(s + "T00:00:00Z").getTime();
    // A recomputed/upserted day (01-14) arrives out of order at the end — as Postgres can return
    // an upserted row out of heap position when the query is unordered. Without the 1d sort this
    // shifts the served series ([1,3,4,2] instead of [1,2,3,4]).
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 8, day: "2026-01-13", avg: 1 },
      { system_id: 1, point_id: 8, day: "2026-01-15", avg: 3 },
      { system_id: 1, point_id: 8, day: "2026-01-16", avg: 4 },
      { system_id: 1, point_id: 8, day: "2026-01-14", avg: 2 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "avg")],
      "1d",
      device,
      d("2026-01-13"),
      d("2026-01-16"),
    );
    expect(out[0].history.data).toEqual([1, 2, 3, 4]);
  });

  it("1d: densifies a sparse day range to the full window (nulls for missing days)", async () => {
    const point = fakePoint({ index: 9, systemId: 1, metricType: "soc" });
    const d = (s: string) => new Date(s + "T00:00:00Z").getTime();
    // Only the last two days of a 5-day window have rows (a sparsely-reporting SoC point). They must
    // land at their true day offsets (indices 3,4), not be packed at the window start — the client
    // aligns positionally (data[i] == day firstInterval+i), so a sparse series would otherwise be
    // mis-placed at the start (the "band stops early" bug).
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 9, day: "2026-01-16", min: 20 },
      { system_id: 1, point_id: 9, day: "2026-01-17", min: 21 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "min")],
      "1d",
      device,
      d("2026-01-13"),
      d("2026-01-17"),
    );
    expect(out[0].history.numIntervals).toBe(5);
    expect(out[0].history.data).toEqual([null, null, null, 20, 21]);
  });

  it("skips a series whose source system is missing", async () => {
    const point = fakePoint({ index: 1, systemId: 999 });
    const allRows: AggRow[] = [
      { system_id: 999, point_id: 1, interval_end: FIVE, avg: 5 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "avg")],
      "5m",
      device,
      FIVE,
      FIVE,
    );
    expect(out).toHaveLength(0);
  });
});
