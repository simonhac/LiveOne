import micromatch from "micromatch";
import type { LineChartData as ChartData } from "@/lib/charts/types";
import type { ChartTimeRange } from "@/lib/charts/scaffold";

// Series patterns to request for a given period (energy mode = M/Y/1d, else power mode).
export function buildSeriesParam(isEnergyMode: boolean): string {
  if (isEnergyMode) {
    return [
      "source.solar/energy.delta",
      "load*/energy.delta",
      "bidi.grid/energy.delta",
      "bidi.battery/soc.{avg,min,max}",
    ].join(",");
  }
  return [
    "source.solar/power.avg",
    "load*/power.avg",
    "bidi.battery/power.avg",
    "bidi.grid/power.avg",
    "bidi.battery/soc.last",
  ].join(",");
}

/**
 * Pure transform: raw OpenNEM payload → windowed, unit-converted ChartData. Runs in a
 * component useMemo (not select), so it recomputes only on refetch / period / window change — the
 * `new Date()` window is therefore evaluated once per data change, keeping arrays stable.
 *
 * `window` selects an explicit historical range `[start, end]` (time-travel); when absent the data is
 * windowed against the live trailing window ending at `now`.
 */
export function buildChartData(
  rawHistory: any,
  timeRange: ChartTimeRange,
  window?: { start: Date; end: Date },
): ChartData | null {
  if (!rawHistory || !Array.isArray(rawHistory.data)) return null;
  const isEnergyMode = timeRange === "M" || timeRange === "Y";

  const findSeries = (pattern: string) =>
    rawHistory.data.find((d: any) => {
      const slashIndex = d.id.indexOf("/");
      if (slashIndex === -1) return false;
      const seriesPath = d.id.substring(slashIndex + 1);
      return micromatch.isMatch(seriesPath, pattern);
    });

  let solarData,
    loadData,
    batteryWData,
    batterySOCData,
    batterySOCMinData,
    batterySOCMaxData,
    gridData;

  if (isEnergyMode) {
    solarData =
      findSeries("source.solar*/energy.delta") ||
      findSeries("solar*/energy.delta");
    loadData = findSeries("load/energy.delta");
    batteryWData = null;
    batterySOCData = findSeries("bidi.battery/soc.avg");
    batterySOCMinData = findSeries("bidi.battery/soc.min");
    batterySOCMaxData = findSeries("bidi.battery/soc.max");
    gridData = findSeries("bidi.grid/energy.delta");
  } else {
    solarData =
      findSeries("source.solar*/power.avg") || findSeries("solar*/power.avg");
    loadData = findSeries("load/power.avg");
    batteryWData = findSeries("bidi.battery/power.avg");
    batterySOCData = findSeries("bidi.battery/soc.last");
    batterySOCMinData = null;
    batterySOCMaxData = null;
    gridData = findSeries("bidi.grid/power.avg");
  }

  const primaryData =
    solarData || loadData || batteryWData || batterySOCData || gridData;
  if (!primaryData) return null;

  const startTime = new Date(primaryData.history.firstInterval);
  const interval = primaryData.history.interval;
  if (!interval) throw new Error("No interval specified in API response");

  let intervalMs: number;
  if (interval === "1d") intervalMs = 24 * 60 * 60000;
  else if (interval === "30m") intervalMs = 30 * 60000;
  else if (interval === "5m") intervalMs = 5 * 60000;
  else if (interval === "1m") intervalMs = 60000;
  else throw new Error(`Unsupported interval: ${interval}`);

  const timestamps: Date[] = primaryData.history.data.map(
    (_: any, index: number) =>
      new Date(startTime.getTime() + index * intervalMs),
  );

  let windowStart: Date;
  let windowEnd: Date;
  if (window) {
    windowStart = window.start;
    windowEnd = window.end;
  } else {
    windowEnd = new Date();
    const windowHours =
      timeRange === "D"
        ? 24
        : timeRange === "W"
          ? 24 * 7
          : timeRange === "M"
            ? 24 * 30
            : 24 * 365;
    windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  }

  const selectedIndices = timestamps
    .map((t, i) => ({ time: t, index: i }))
    .filter(({ time }) => time >= windowStart && time <= windowEnd)
    .map(({ index }) => index);

  // No data points fall within the window (e.g. a brand-new device with no aggregates yet, or a
  // historical window before the device existed). Treat as "no data" so the card renders its empty
  // state instead of an empty chart — and so downstream code never dereferences timestamps[0] on an
  // empty array (the `firstTime.getTime()` crash in the SoC-padding path).
  if (selectedIndices.length === 0) return null;

  const convertToKw = (value: number | null, units: string): number | null => {
    if (value === null) return null;
    const unitsLower = units?.toLowerCase() || "";
    if (unitsLower === "w" || unitsLower === "wh") return value / 1000;
    return value;
  };

  return {
    timestamps: selectedIndices.map((i) => timestamps[i]),
    solar: solarData
      ? selectedIndices.map((i) =>
          convertToKw(solarData.history.data[i], solarData.units),
        )
      : selectedIndices.map(() => null),
    load: loadData
      ? selectedIndices.map((i) =>
          convertToKw(loadData.history.data[i], loadData.units),
        )
      : selectedIndices.map(() => null),
    batteryW: batteryWData
      ? selectedIndices.map((i) =>
          convertToKw(batteryWData.history.data[i], batteryWData.units),
        )
      : selectedIndices.map(() => null),
    batterySOC: batterySOCData
      ? selectedIndices.map((i) => batterySOCData.history.data[i])
      : selectedIndices.map(() => null),
    batterySOCMin: batterySOCMinData
      ? selectedIndices.map((i) => batterySOCMinData.history.data[i])
      : undefined,
    batterySOCMax: batterySOCMaxData
      ? selectedIndices.map((i) => batterySOCMaxData.history.data[i])
      : undefined,
    grid: gridData
      ? selectedIndices.map((i) =>
          convertToKw(gridData.history.data[i], gridData.units),
        )
      : undefined,
    mode: isEnergyMode ? "energy" : "power",
  } as ChartData;
}
