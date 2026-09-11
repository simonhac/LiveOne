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

  it("30m: rows are served verbatim — bucketing happened in SQL upstream (ReadingsDao.read30m)", async () => {
    // fetchAggRowsPg hands this builder rows already reduced to the dense :00/:30 grid, one row per
    // bucket per point. There is no JS reduce step left: the per-field semantics (avg mean / delta
    // sum / min-max extreme / last + quality last-in-bucket) are pinned on the SQL read.
    const point = fakePoint({ index: 1, systemId: 1 });
    const THIRTY = 30 * 60 * 1000;
    const allRows: AggRow[] = [
      { system_id: 1, point_id: 1, interval_end: THIRTY, avg: 20 },
      { system_id: 1, point_id: 1, interval_end: 2 * THIRTY, avg: null },
      { system_id: 1, point_id: 1, interval_end: 3 * THIRTY, avg: 35 },
    ];
    const out = await buildSeriesFromAggRows(
      allRows,
      [seriesInfo(point, "avg")],
      "30m",
      device,
      THIRTY,
      3 * THIRTY,
    );
    expect(out[0].history.data).toEqual([20, null, 35]);
    expect(out[0].history.numIntervals).toBe(3);
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

describe("a lifetime counter's .last is served unrounded", () => {
  /**
   * 🛑 Real values, straight off Daylesford's `load_wh_total` on 2026-09-09. Consecutive readings
   * differ by 86 and 85 Wh on a value of ~5.55 million, so `toPrecision(4)` moves each by up to
   * ±500 Wh — proportionally nothing against the value, roughly 1000% of the increment anyone
   * actually reads. Served rounded, a whole day of this series collapsed from 288 distinct readings
   * to 9, all ending in three zeros, and the counter could not be chained across an outage to
   * better than ±1 kWh — which is the entire reason `.last` is exposed on an energy point.
   */
  const COUNTER = [5551623, 5551709, 5551794];

  const counterPoint = () =>
    fakePoint({
      index: 7,
      systemId: 1,
      transform: "d",
      metricType: "energy",
      metricUnit: "Wh",
    });

  const rowsFor = (field: "last" | "delta", values: number[]): AggRow[] =>
    values.map((v, i) => ({
      system_id: 1,
      point_id: 7,
      interval_end: (i + 1) * FIVE,
      [field]: v,
    })) as AggRow[];

  it("keeps every digit of the meter reading", async () => {
    const out = await buildSeriesFromAggRows(
      rowsFor("last", COUNTER),
      [seriesInfo(counterPoint(), "last")],
      "5m",
      device,
      FIVE,
      3 * FIVE,
    );
    expect(out[0].history.data).toEqual(COUNTER);
  });

  it("preserves the increments that rounding destroyed", async () => {
    // The property that matters: consecutive differences survive the serializer. Under
    // toPrecision(4) all three collapse to 5552000 and every increment becomes 0.
    const out = await buildSeriesFromAggRows(
      rowsFor("last", COUNTER),
      [seriesInfo(counterPoint(), "last")],
      "5m",
      device,
      FIVE,
      3 * FIVE,
    );
    const data = out[0].history.data as number[];
    expect([data[1] - data[0], data[2] - data[1]]).toEqual([86, 85]);
  });

  it("still rounds the counter's own delta — small numbers, nothing to lose", async () => {
    // Scoped to `.last`: `.delta` carries few significant figures, so the display precision is
    // doing no harm there and the exemption should not spread.
    const out = await buildSeriesFromAggRows(
      rowsFor("delta", [86.12345]),
      [seriesInfo(counterPoint(), "delta")],
      "5m",
      device,
      FIVE,
      FIVE,
    );
    expect(out[0].history.data).toEqual([86.12]);
  });

  it("still rounds .last on a point that is NOT a counter", async () => {
    // The exemption keys on `transform: 'd'`, not on the aggregation alone — a power point's
    // `.last` is an instantaneous reading and gets the usual display precision.
    const power = fakePoint({ index: 8, systemId: 1, metricType: "power" });
    const out = await buildSeriesFromAggRows(
      [{ system_id: 1, point_id: 8, interval_end: FIVE, last: 1.23456 }],
      [seriesInfo(power, "last")],
      "5m",
      device,
      FIVE,
      FIVE,
    );
    expect(out[0].history.data).toEqual([1.235]);
  });
});
