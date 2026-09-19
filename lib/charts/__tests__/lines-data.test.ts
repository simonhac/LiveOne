import { describe, it, expect } from "@jest/globals";
import { buildChartData } from "../lines-data";

// Minimal OpenNEM-shaped history payload builder. `data` is the per-interval value array; a series
// with an empty `data` array models a brand-new device that has no aggregates for the interval yet.
const series = (id: string, units: string, data: (number | null)[]) => ({
  id,
  units,
  history: { firstInterval: "2024-08-22T00:00:00Z", interval: "", data },
});
const withInterval = (s: ReturnType<typeof series>, interval: string) => ({
  ...s,
  history: { ...s.history, interval },
});

describe("buildChartData", () => {
  it("returns null when the payload has no series data", () => {
    expect(buildChartData(null, "D")).toBeNull();
    expect(buildChartData({}, "D")).toBeNull();
    expect(buildChartData({ data: [] }, "D")).toBeNull();
  });

  // The device-page crash regression: a brand-new BATTERY device on M. The API returns the
  // configured energy series (incl. soc.min/max) but with EMPTY history.data. Before the fix this
  // returned a non-null ChartData with empty timestamps + empty-but-truthy batterySOCMin/Max, which
  // made LinesChartCard's SoC-padding run `timestamps[0].getTime()` on undefined and white-screen.
  it("returns null for an M battery device with empty history (no getTime crash)", () => {
    const payload = {
      data: [
        withInterval(series("13/source.solar/energy.delta", "kWh", []), "1d"),
        withInterval(series("13/load/energy.delta", "kWh", []), "1d"),
        withInterval(series("13/bidi.battery/soc.avg", "%", []), "1d"),
        withInterval(series("13/bidi.battery/soc.min", "%", []), "1d"),
        withInterval(series("13/bidi.battery/soc.max", "%", []), "1d"),
      ],
    };
    expect(buildChartData(payload, "M")).toBeNull();
  });

  it("returns null when no data points fall within the requested window", () => {
    const payload = {
      data: [
        withInterval(
          series("13/source.solar/power.avg", "W", [1000, 2000, 3000]),
          "5m",
        ),
      ],
    };
    // Data is at 2024-08-22; a window years later selects nothing → null (not an empty chart).
    const cd = buildChartData(payload, "D", {
      start: new Date("2030-01-01T00:00:00Z"),
      end: new Date("2030-01-02T00:00:00Z"),
    });
    expect(cd).toBeNull();
  });

  it("builds power-mode ChartData for a device with data (W→kW, window-clipped)", () => {
    const payload = {
      data: [
        withInterval(
          series("13/source.solar/power.avg", "W", [1000, 2000, null]),
          "5m",
        ),
        withInterval(series("13/load/power.avg", "W", [500, 600, 700]), "5m"),
        withInterval(
          series("13/bidi.battery/soc.last", "%", [50, 51, 52]),
          "5m",
        ),
      ],
    };
    const cd = buildChartData(payload, "D", {
      start: new Date("2024-08-22T00:00:00Z"),
      end: new Date("2024-08-22T02:00:00Z"),
    });
    expect(cd).not.toBeNull();
    expect(cd!.mode).toBe("power");
    expect(cd!.timestamps).toHaveLength(3); // three 5m intervals inside the 2h window
    expect(cd!.solar).toEqual([1, 2, null]); // W → kW
    expect(cd!.load).toEqual([0.5, 0.6, 0.7]);
    expect(cd!.batterySOC).toEqual([50, 51, 52]);
  });
});

describe("buildChartData — Y rolls its days up to calendar months", () => {
  /** `count` daily values from `fromYMD`, as the API's `1d` shape. */
  const daily = (
    id: string,
    units: string,
    fromYMD: string,
    data: (number | null)[],
  ) => ({
    id,
    units,
    history: {
      firstInterval: `${fromYMD}T00:00:00Z`,
      interval: "1d",
      data,
    },
  });

  /** A trailing 365-day window ending on the last day's marker, as the live Y view builds it. */
  const yearWindow = (fromYMD: string, n: number) => {
    const start = new Date(`${fromYMD}T00:00:00Z`);
    return {
      start,
      end: new Date(start.getTime() + (n - 1) * 24 * 60 * 60_000),
    };
  };

  it("emits one bucket per calendar month, with spans and summed energy", () => {
    // 2025-06-15 → 2026-06-14 inclusive: 365 days across 13 calendar months.
    const n = 365;
    const solar = Array.from({ length: n }, () => 2); // 2 kWh every day
    const load = Array.from({ length: n }, () => 1);
    const payload = {
      data: [
        daily("13/source.solar/energy.delta", "kWh", "2025-06-15", solar),
        daily("13/load/energy.delta", "kWh", "2025-06-15", load),
      ],
    };
    const cd = buildChartData(payload, "Y", yearWindow("2025-06-15", n))!;

    expect(cd.mode).toBe("energy");
    expect(cd.timestamps).toHaveLength(13);
    expect(cd.barSpans).toHaveLength(13);
    // Timestamps are the buckets' (clamped) starts; the first is mid-June, the rest are 1sts.
    expect(cd.timestamps[0].toISOString().slice(0, 10)).toBe("2025-06-15");
    expect(cd.timestamps[1].toISOString().slice(0, 10)).toBe("2025-07-01");

    // A month's bar is the SUM of its days — 16 days of June, then all 31 of July.
    expect(cd.solar[0]).toBe(32);
    expect(cd.solar[1]).toBe(62);
    // And the year's bars still add up to the year's energy: nothing is lost or double-counted.
    const total = cd.solar.reduce((sum: number, v) => sum + (v ?? 0), 0);
    expect(total).toBe(2 * n);
    expect(cd.load.reduce((sum: number, v) => sum + (v ?? 0), 0)).toBe(1 * n);

    // The partial first bucket is genuinely shorter, which is what draws it narrower.
    const first = cd.barSpans![0];
    const second = cd.barSpans![1];
    expect(first.end.getTime() - first.start.getTime()).toBeLessThan(
      second.end.getTime() - second.start.getTime(),
    );
    // Spans are contiguous: each picks up exactly where the last left off.
    cd.barSpans!.slice(1).forEach((s, i) => {
      expect(s.start.getTime()).toBe(cd.barSpans![i].end.getTime());
    });
  });

  it("averages SoC and keeps the month's true min/max, rather than summing them", () => {
    const n = 62; // all of July + all of August 2025
    const payload = {
      data: [
        daily(
          "13/source.solar/energy.delta",
          "kWh",
          "2025-07-01",
          Array.from({ length: n }, () => 1),
        ),
        daily(
          "13/bidi.battery/soc.avg",
          "%",
          "2025-07-01",
          Array.from({ length: n }, (_, i) => (i < 31 ? 50 : 70)),
        ),
        daily(
          "13/bidi.battery/soc.min",
          "%",
          "2025-07-01",
          Array.from({ length: n }, (_, i) => (i === 3 ? 12 : 40)),
        ),
        daily(
          "13/bidi.battery/soc.max",
          "%",
          "2025-07-01",
          Array.from({ length: n }, (_, i) => (i === 3 ? 99 : 80)),
        ),
      ],
    };
    const cd = buildChartData(payload, "Y", yearWindow("2025-07-01", n))!;

    expect(cd.timestamps).toHaveLength(2);
    expect(cd.batterySOC).toEqual([50, 70]);
    // July dipped to 12 % on one day — averaging the daily minima would have hidden that.
    expect(cd.batterySOCMin).toEqual([12, 40]);
    expect(cd.batterySOCMax).toEqual([99, 80]);
  });

  it("leaves an absent series absent rather than turning it into an all-nulls array", () => {
    // An array — even of nulls — is truthy, which is what put a phantom Battery/Grid dataset in the
    // legend before (see LineChartData.batteryW). The roll-up must not reintroduce that.
    const n = 40;
    const payload = {
      data: [
        daily(
          "13/source.solar/energy.delta",
          "kWh",
          "2025-07-01",
          Array.from({ length: n }, () => 1),
        ),
      ],
    };
    const cd = buildChartData(payload, "Y", yearWindow("2025-07-01", n))!;
    expect(cd.batteryW).toBeUndefined();
    expect(cd.grid).toBeUndefined();
    expect(cd.batterySOCMin).toBeUndefined();
    expect(cd.batterySOCMax).toBeUndefined();
  });

  it("leaves M alone — one bar per day, no spans", () => {
    const n = 31;
    const payload = {
      data: [
        daily(
          "13/source.solar/energy.delta",
          "kWh",
          "2025-07-01",
          Array.from({ length: n }, () => 3),
        ),
      ],
    };
    const cd = buildChartData(payload, "M", yearWindow("2025-07-01", n))!;
    expect(cd.timestamps).toHaveLength(31);
    expect(cd.barSpans).toBeUndefined();
    expect(cd.solar[0]).toBe(3);
  });
});
