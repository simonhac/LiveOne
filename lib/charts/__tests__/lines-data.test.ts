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
    expect(buildChartData(null, "1D")).toBeNull();
    expect(buildChartData({}, "1D")).toBeNull();
    expect(buildChartData({ data: [] }, "1D")).toBeNull();
  });

  // The device-page crash regression: a brand-new BATTERY device on 30D. The API returns the
  // configured energy series (incl. soc.min/max) but with EMPTY history.data. Before the fix this
  // returned a non-null ChartData with empty timestamps + empty-but-truthy batterySOCMin/Max, which
  // made LinesChartCard's SoC-padding run `timestamps[0].getTime()` on undefined and white-screen.
  it("returns null for a 30D battery device with empty history (no getTime crash)", () => {
    const payload = {
      data: [
        withInterval(series("13/source.solar/energy.delta", "kWh", []), "1d"),
        withInterval(series("13/load/energy.delta", "kWh", []), "1d"),
        withInterval(series("13/bidi.battery/soc.avg", "%", []), "1d"),
        withInterval(series("13/bidi.battery/soc.min", "%", []), "1d"),
        withInterval(series("13/bidi.battery/soc.max", "%", []), "1d"),
      ],
    };
    expect(buildChartData(payload, "30D")).toBeNull();
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
    const cd = buildChartData(payload, "1D", {
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
    const cd = buildChartData(payload, "1D", {
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
