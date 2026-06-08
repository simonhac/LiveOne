import { describe, it, expect, jest } from "@jest/globals";

// Decouple from SeriesPath/identifier internals and the systems cache: getSeriesPath → a simple
// id, SystemsManager.getSystem → present for all systems except 999 (to test the skip path).
jest.mock("@/lib/point/series-info", () => ({
  getSeriesPath: (s: {
    point: { index: number };
    aggregationField: string;
  }) => ({
    toString: () => `${s.point.index}/${s.aggregationField}`,
  }),
}));
jest.mock("@/lib/systems-manager", () => ({
  SystemsManager: {
    getInstance: () => ({
      getSystem: async (id: number) => (id === 999 ? null : { id }),
    }),
  },
}));

import { buildSeriesFromAggRows, type AggRow } from "../build-series";
import type { SeriesInfo } from "@/lib/point/series-info";

const FIVE = 5 * 60 * 1000;
const system = { timezoneOffsetMin: 600 } as any;

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
      system,
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
      system,
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
      system,
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
      system,
      0,
      30 * 60 * 1000,
    );
    expect(out[0].history.data).toEqual([20]); // (10+20+30)/3
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
      system,
      dayMs,
      dayMs,
    );
    expect(out[0].id).toBe("2/delta");
    expect(out[0].history.data).toEqual([42]);
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
      system,
      FIVE,
      FIVE,
    );
    expect(out).toHaveLength(0);
  });
});
