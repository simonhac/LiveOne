import micromatch from "micromatch";
import type { LineChartData as ChartData } from "@/lib/charts/types";
import type { ChartTimeRange } from "@/lib/charts/temporal";
import { monthBuckets, rollUp } from "@/lib/charts/month-buckets";

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
    // A site whose load meter is a HIERARCHY has no bare `load` power point — the master is the
    // energy register and the complement is its power-metered `load.rest-of-house` (Sigenergy). Fall back to it
    // so the load trace keeps showing exactly the series it always did.
    loadData =
      findSeries("load/power.avg") ||
      findSeries("load.rest-of-house/power.avg");
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

  const built: ChartData = {
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
    // `undefined` when absent, matching `grid` below — NOT an all-nulls array. An array (even of
    // nulls) is truthy, so the old form made the dataset builder add a phantom Battery series for
    // every battery-less device and in energy mode. See LineChartData.batteryW.
    batteryW: batteryWData
      ? selectedIndices.map((i) =>
          convertToKw(batteryWData.history.data[i], batteryWData.units),
        )
      : undefined,
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
  };

  return timeRange === "Y" ? rollUpYearToMonths(built, intervalMs) : built;
}

/**
 * Y: fold the ~365 daily bars into one per calendar month.
 *
 * The energy series are already true kWh (`energy.delta`, not a power average), so a month's bar is
 * a plain SUM of its days — no unit fix is needed here, unlike the stacked site charts. SoC avg
 * averages and SoC min/max keep the extreme, so a month's band still spans what the battery
 * actually did rather than the mildest version of it.
 *
 * `barSpans` is what makes the result drawable: months are 28–31 days long, so the renderer places
 * the bars on the time scale instead of giving each an equal slice of the plot (see `BarSpan`).
 */
function rollUpYearToMonths(cd: ChartData, intervalMs: number): ChartData {
  if (cd.timestamps.length === 0) return cd;
  const buckets = monthBuckets(
    cd.timestamps,
    cd.timestamps[0],
    // Exclusive: a day marker names the START of its day, so the last bar has to cover it.
    new Date(cd.timestamps[cd.timestamps.length - 1].getTime() + intervalMs),
  );
  const sum = (v: (number | null)[] | undefined) =>
    v ? rollUp(v, buckets, "sum") : undefined;
  return {
    ...cd,
    timestamps: buckets.map((b) => b.start),
    solar: rollUp(cd.solar, buckets, "sum"),
    load: rollUp(cd.load, buckets, "sum"),
    // `undefined` stays `undefined` — an absent series must not become an all-nulls ARRAY, which is
    // truthy and would put a phantom dataset back in the legend. See LineChartData.batteryW.
    batteryW: sum(cd.batteryW),
    batterySOC: rollUp(cd.batterySOC, buckets, "mean"),
    batterySOCMin: cd.batterySOCMin
      ? rollUp(cd.batterySOCMin, buckets, "min")
      : undefined,
    batterySOCMax: cd.batterySOCMax
      ? rollUp(cd.batterySOCMax, buckets, "max")
      : undefined,
    grid: sum(cd.grid),
    barSpans: buckets.map((b) => ({ start: b.start, end: b.end })),
  };
}
