import { ChartData, SeriesData } from "@/lib/charts/types";
import type { ChartTimeRange } from "@/lib/charts/scaffold";
import { generateSeriesConfig } from "@/lib/charts/series-config";
import { getColorForPath } from "@/lib/chart-colors";
import { flowPathForSeries } from "@/lib/aggregation/flow-node-meta";
import type { DailyFlowMatrices, EnergyFlowMatrix } from "./energy-flow-matrix";
import { SeriesPath } from "@/lib/identifiers";
import { matchesLogicalPath, stemSplit } from "@/lib/identifiers/logical-path";
import { encodeHistoryWindow } from "@/lib/charts/history-window";
import { fetchJson } from "@/lib/queries/fetcher";

export interface ProcessedSiteData {
  load: ChartData | null;
  generation: ChartData | null;
  requestStart?: string;
  requestEnd?: string;
  /** Server-computed sub-daily energy-flow matrix (when served), else null → compute client-side. */
  flowMatrix?: EnergyFlowMatrix | null;
  /** Server-computed ATTRIBUTED flow matrix (energy + emissions/renewable/cost/estimated legs) behind
   *  the Sankey node tooltips — served for every interval; absent/null → tooltips degrade to
   *  energy-only (P3), same fallback discipline as `flowMatrix`. */
  attributedFlow?: DailyFlowMatrices | null;
  /** Hot-water temperature series (`load.hws/temperature.avg`) — only requested/populated for the D
   *  period (see `fetchSiteData`'s `period === "D"` branch); null/absent otherwise. The hot-water
   *  tile's sparkline is always a 24h/5m window, which the D site fetch already is, so it reads this
   *  instead of firing its own `/api/history` call in that case. */
  hwsTemperature?: { timestamps: Date[]; values: (number | null)[] } | null;
  /**
   * The grid's per-interval BUY and SELL prices (c/kWh, aligned to the chart timestamps), behind the
   * legend tables' hovered "Import Price" / "Export Price" line. Requested for every period; absent
   * (null entries throughout) for an Area with no bound grid rate points.
   *
   * ⚠️ Signs are the vendor's, NOT normalised: `import` is positive when you pay, and `export` is
   * Amber's raw `feedIn.perKwh`, which is NEGATIVE when you are PAID. The engine normalises its own
   * copy for the `revenue_c` leg (`resolveExportReceiptSeries`) but that never touches these raw
   * series, so the display flip lives at the render site — see `EnergyTable`.
   *
   * Forward-filled to the chart grid by {@link forwardFillRate}: Amber's rates are 30-min native, so
   * at the D period's 5-min grid 5 of every 6 buckets arrive null and would otherwise read "—".
   */
  gridRates?: { import: (number | null)[]; export: (number | null)[] } | null;
  /**
   * Every series of this fetch's `/api/history` response, UNFILTERED and UNSPLIT — i.e. before the
   * power/SoC/hws partition and before `splitBatteryPower`. `LinesChartCard` feeds it straight to
   * `buildChartData` (whose `findSeries` micromatches on `id`), which is how a `lines` chart rides
   * this fetch instead of issuing a second, redundant `/api/history` for the same window.
   *
   * `fetchAndProcessSiteData` — the only producer — sets this on EVERY path where the HTTP fetch
   * succeeded, including the ones where there is nothing to chart as a site (no series at all, or
   * none of type `power`): an area the site processor can't chart must still be able to hand the
   * lines chart its raw series, or the merge would trade one request for a blank card. Optional
   * only so hand-built `ProcessedSiteData` fixtures (energy-flow-matrix tests) need not carry it.
   */
  rawSeries?: ParsedSeries[];
}

/**
 * Series data from the history API with parsed path
 */
export interface ParsedSeries {
  id: string;
  type: string;
  units: string;
  history: {
    firstInterval: string;
    lastInterval: string;
    interval: string;
    data: (number | null)[];
  };
  path?: string; // Simplified path string (e.g., "bidi.battery/soc.last")
  seriesPath?: SeriesPath | null; // Parsed full series path from id
  label?: string;
}

// Display label for rest of house / other loads synthetic series
const REST_OF_HOUSE_LABEL = "Other";

/**
 * Fetch data from the history API and parse all series IDs into SeriesPath objects
 */
async function fetchHistoryData(
  systemId: string,
  requestInterval: string,
  duration: string,
  seriesFilter: string,
  startTime?: string,
  endTime?: string,
): Promise<{
  series: ParsedSeries[];
  requestStart?: string;
  requestEnd?: string;
  flowMatrix?: EnergyFlowMatrix | null;
  attributedFlow?: DailyFlowMatrices | null;
}> {
  // Build API URL - use absolute time if provided, otherwise use relative
  let apiUrl: string;
  if (startTime && endTime) {
    // Historical data with specific time range — encode via the shared history-window encoder
    // (same encoding the line chart uses, so requests + cache keys stay aligned).
    const { startTime: startEncoded, endTime: endEncoded } =
      encodeHistoryWindow(startTime, endTime, requestInterval);
    apiUrl = `/api/history?interval=${requestInterval}&startTime=${startEncoded}&endTime=${endEncoded}&systemId=${systemId}&series=${seriesFilter}`;
  } else {
    // Current/live data - use relative time
    apiUrl = `/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId}&series=${seriesFilter}`;
  }

  // Ask the history endpoint to bundle the energy-flow Sankey payload alongside the series data — for
  // EVERY interval now (1d included: the attributed flow_attr_1d read replaced the old flat refusal),
  // so the Sankey + its node tooltips ride the one site-data fetch with no separate 30D query.
  apiUrl += "&include=sankey";

  // Use the shared fetcher so a dashboard share token (?access=) in the page URL is propagated
  // to the same-origin /api request (bare fetch would drop it → 401 on shared views).
  const data = await fetchJson<any>(apiUrl);

  // Check if we have data
  if (!data || !data.data || !Array.isArray(data.data)) {
    console.warn("No data returned from history API:", data);
    return {
      series: [],
      requestStart: data?.requestStart,
      requestEnd: data?.requestEnd,
      flowMatrix: data?.flowMatrix ?? null,
      attributedFlow: data?.attributedFlow ?? null,
    };
  }

  // Parse all series IDs at the serialization boundary
  // Series ID format: "systemId/pointPath/metricType.aggregation" (e.g., "1/bidi.battery/soc.last")
  const parsedSeries: ParsedSeries[] = data.data.map((s: any) => ({
    ...s,
    seriesPath: s.id ? SeriesPath.parse(s.id) : null,
  }));

  return {
    series: parsedSeries,
    requestStart: data.requestStart,
    requestEnd: data.requestEnd,
    flowMatrix: data.flowMatrix ?? null,
    attributedFlow: data.attributedFlow ?? null,
  };
}

/**
 * Data fetched and prepared for processing
 */
interface FetchedSiteData {
  powerSeries: ParsedSeries[];
  socSeries: ParsedSeries[];
  /** `load.hws/temperature` series, when requested (1D only — see `fetchSiteData`). */
  hwsSeries: ParsedSeries[];
  /** `bidi.grid.{import,export}/rate` series — the legend tables' hovered price. Empty when unbound. */
  rateSeries: ParsedSeries[];
  timestamps: Date[];
  selectedIndices: number[];
  filteredTimestamps: Date[];
  requestInterval: string;
  requestStart?: string;
  requestEnd?: string;
  /** Server-computed sub-daily energy-flow matrix (when ?include=sankey is served), else null. */
  flowMatrix?: EnergyFlowMatrix | null;
  /** Server-computed attributed flow matrix (when ?include=sankey is served), else null. */
  attributedFlow?: DailyFlowMatrices | null;
}

/**
 * Split battery power series into charge and discharge
 */
function splitBatteryPower(powerSeries: ParsedSeries[]): ParsedSeries[] {
  const batteryPowerIndex = powerSeries.findIndex((s) =>
    matchesLogicalPath(s.seriesPath!.pointPath, "bidi.battery", "power"),
  );

  if (batteryPowerIndex === -1) {
    console.log(
      "[Site Processor] Battery series NOT found - charge/discharge will show as 0",
    );
    return powerSeries;
  }

  const batterySeries = powerSeries[batteryPowerIndex];

  // Create charge series (negative values -> positive)
  const chargeData = batterySeries.history.data.map((v: number | null) =>
    v !== null && v < 0 ? Math.abs(v) : 0,
  );
  const chargeSeries = {
    ...batterySeries,
    id: batterySeries.id.replace("/power.", "/power.charge."),
    path: "bidi.battery.charge/power",
    label: "Battery Charge",
    history: {
      ...batterySeries.history,
      data: chargeData,
    },
  };

  // Create discharge series (positive values)
  const dischargeSeries = {
    ...batterySeries,
    id: batterySeries.id.replace("/power.", "/power.discharge."),
    path: "bidi.battery.discharge/power",
    label: "Battery Discharge",
    history: {
      ...batterySeries.history,
      data: batterySeries.history.data.map((v: number | null) =>
        v !== null && v > 0 ? v : 0,
      ),
    },
  };

  console.log(
    "[Site Processor] Split battery into charge and discharge series",
  );

  // Replace the original battery series with charge and discharge
  return [
    ...powerSeries.slice(0, batteryPowerIndex),
    chargeSeries,
    dischargeSeries,
    ...powerSeries.slice(batteryPowerIndex + 1),
  ];
}

/**
 * Calculate timestamps and time window
 */
function calculateTimeWindow(
  firstSeries: ParsedSeries,
  period: ChartTimeRange,
  startTime?: string,
  endTime?: string,
): {
  timestamps: Date[];
  selectedIndices: number[];
  filteredTimestamps: Date[];
} {
  const startTimeString = firstSeries.history.firstInterval;
  const dataStartTime = new Date(startTimeString);
  const interval = firstSeries.history.interval;

  let intervalMs: number;
  if (interval === "1d") {
    intervalMs = 24 * 60 * 60000;
  } else if (interval === "30m") {
    intervalMs = 30 * 60000;
  } else if (interval === "5m") {
    intervalMs = 5 * 60000;
  } else if (interval === "1m") {
    intervalMs = 60000;
  } else {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  const timestamps = firstSeries.history.data.map(
    (_: any, index: number) =>
      new Date(dataStartTime.getTime() + index * intervalMs),
  );

  // Calculate window boundaries
  let windowStart: Date;
  let windowEnd: Date;

  if (startTime && endTime) {
    windowStart = new Date(startTime);
    windowEnd = new Date(endTime);
  } else {
    const currentTime = new Date();
    let windowHours: number;
    let intervalMinutes: number;

    // Only reached in LIVE mode (no explicit start/end). D/W hit their own branches; M/Y always
    // arrive with an explicit calendar window, so the `else` (M/Y) is effectively unreachable here.
    if (period === "D") {
      windowHours = 24;
      intervalMinutes = 5;
    } else if (period === "W") {
      windowHours = 24 * 7;
      intervalMinutes = 30;
    } else {
      windowHours = 24 * 30;
      intervalMinutes = 24 * 60;
    }

    const currentMinutes = currentTime.getMinutes();
    const roundedMinutes =
      Math.floor(currentMinutes / intervalMinutes) * intervalMinutes;
    windowEnd = new Date(currentTime);
    windowEnd.setMinutes(roundedMinutes, 0, 0);

    windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  }

  const selectedIndices = timestamps
    .map((t: Date, i: number) => ({ time: t, index: i }))
    .filter(
      ({ time }: { time: Date; index: number }) =>
        time >= windowStart && time <= windowEnd,
    )
    .map(({ index }: { time: Date; index: number }) => index);

  console.log(
    `[Site Processor] Time window: ${windowStart.toISOString()} to ${windowEnd.toISOString()}`,
  );
  console.log(
    `[Site Processor] Total timestamps: ${timestamps.length}, Selected: ${selectedIndices.length}`,
  );
  if (timestamps.length > 0) {
    console.log(
      `[Site Processor] First timestamp: ${timestamps[0].toISOString()}, Last: ${timestamps[timestamps.length - 1].toISOString()}`,
    );
  }

  const filteredTimestamps = selectedIndices.map((i: number) => timestamps[i]);

  return { timestamps, selectedIndices, filteredTimestamps };
}

/**
 * Fetch site data from API and prepare it for processing.
 *
 * Returns BOTH halves separately: `rawSeries` (every series the response carried, always) and
 * `processable` (null when there is nothing to chart as a site). They are split because the two have
 * different audiences — the stacked charts/Sankey need the processed halves, while the `lines` chart
 * rides `rawSeries` and must still get its data on the paths where the site processing bails.
 */
async function fetchSiteData(
  systemId: string,
  period: ChartTimeRange,
  startTime?: string,
  endTime?: string,
): Promise<{ rawSeries: ParsedSeries[]; processable: FetchedSiteData | null }> {
  // Map period to request parameters. `duration` (the `last=` live window) is only used by D/W —
  // M/Y always pass an explicit `startTime`/`endTime` calendar window.
  let requestInterval: string;
  let duration: string;

  if (period === "D") {
    requestInterval = "5m";
    duration = "24h";
  } else if (period === "W") {
    requestInterval = "30m";
    duration = "168h";
  } else {
    requestInterval = "1d";
    duration = "30d";
  }

  // Build series filter based on interval
  let seriesFilter: string;
  if (requestInterval === "1d") {
    seriesFilter = "*/power.avg,bidi.battery/soc.{min,avg,max}";
  } else {
    seriesFilter = "*/power.avg,bidi.battery/soc.last";
  }
  // The hot-water tile's sparkline is always a 24h/5m window — exactly the D period's own request
  // — so piggyback it on this fetch only then; W/M/Y keep the tile's own dedicated fetch (their
  // window/resolution doesn't match what the sparkline needs).
  if (period === "D") {
    seriesFilter += ",load.hws/temperature.avg";
  }
  // The grid's buy/sell prices, for the legend tables' hovered "Import Price" / "Export Price" line.
  // Every period: at 1d `rate.avg` is that day's mean price, which is what a hovered day should show.
  // (Only ever DISPLAYED — the window's dollar totals come from the attributed flow matrix's
  // cost/revenue legs, never from multiplying these by anything client-side.)
  seriesFilter += ",bidi.grid.import/rate.avg,bidi.grid.export/rate.avg";

  // Fetch and parse all series data
  const {
    series: allSeries,
    requestStart,
    requestEnd,
    flowMatrix,
    attributedFlow,
  } = await fetchHistoryData(
    systemId,
    requestInterval,
    duration,
    seriesFilter,
    startTime,
    endTime,
  );

  if (allSeries.length === 0) {
    console.warn("No series data available in response");
    return { rawSeries: allSeries, processable: null };
  }

  // Separate power, SoC, hot-water-temperature and grid-rate series. The non-power ones are ALL typed
  // "power" in the OpenNEM payload (a legacy field, not the real metric — see build-series.ts), so the
  // type filter alone would pull them in; exclude them by path so they're handled only via their own
  // overlays — a c/kWh price stacked into a kW chart would be silently absurd rather than an error.
  // (socSeries / addSocSeries below; hwsSeries via ProcessedSiteData.hwsTemperature). Otherwise an
  // empty SoC series (e.g. a battery SoC point with no 1d aggregates, which sorts first) would become
  // powerSeries[0] and zero the whole chart's timeline in calculateTimeWindow.
  let powerSeries = allSeries.filter(
    (d) =>
      d.type === "power" &&
      !matchesLogicalPath(d.seriesPath!.pointPath, "bidi.battery", "soc") &&
      !matchesLogicalPath(d.seriesPath!.pointPath, "load.hws", "temperature") &&
      !matchesLogicalPath(d.seriesPath!.pointPath, "bidi.grid", "rate"),
  );
  if (powerSeries.length === 0) {
    console.warn("No power series data available in response");
    return { rawSeries: allSeries, processable: null };
  }

  // Split battery power into charge/discharge
  powerSeries = splitBatteryPower(powerSeries);

  // Extract SoC series
  const socSeries = allSeries.filter((d) =>
    matchesLogicalPath(d.seriesPath!.pointPath, "bidi.battery", "soc"),
  );
  console.log(
    "[Site Processor] Found SoC series:",
    socSeries.map((s) => s.path),
  );
  console.log(
    "[Site Processor] Available series IDs:",
    powerSeries.map((s) => s.id),
  );

  // Extract hot-water temperature series (1D only — see the seriesFilter branch above).
  const hwsSeries = allSeries.filter((d) =>
    matchesLogicalPath(d.seriesPath!.pointPath, "load.hws", "temperature"),
  );

  // Extract the grid buy/sell rate series (empty for an Area with no bound rate points).
  const rateSeries = allSeries.filter((d) =>
    matchesLogicalPath(d.seriesPath!.pointPath, "bidi.grid", "rate"),
  );

  // Calculate timestamps and time window. Build the master timeline from a series that actually has
  // data — a single empty/short leading series must never collapse the whole chart's timeline.
  const timelineSeries =
    powerSeries.find((s) => s.history.data.length > 0) ?? powerSeries[0];
  const { timestamps, selectedIndices, filteredTimestamps } =
    calculateTimeWindow(timelineSeries, period, startTime, endTime);

  return {
    rawSeries: allSeries,
    processable: {
      powerSeries,
      socSeries,
      hwsSeries,
      rateSeries,
      timestamps,
      selectedIndices,
      filteredTimestamps,
      requestInterval,
      requestStart,
      requestEnd,
      flowMatrix,
      attributedFlow,
    },
  };
}

/**
 * Convert units to kW or kWh (units are always proper SI format: W, Wh, kW, kWh)
 */
function convertUnits(units: string): number {
  // Units are always proper SI format from metricUnit field
  if (units === "W" || units === "Wh") {
    return 1000; // Convert W→kW or Wh→kWh
  }
  // Already in kW/kWh or other units (%, text, etc.)
  return 1;
}

/**
 * Extract and convert series data for selected time indices
 */
function extractSeriesData(
  dataSeries: ParsedSeries,
  selectedIndices: number[],
  config: any,
): (number | null)[] {
  const conversionFactor = convertUnits(dataSeries.units || "W");

  let seriesValues = selectedIndices.map((i: number) => {
    const val = dataSeries.history.data[i];
    return val === null ? null : val / conversionFactor;
  });

  // Apply any data transformation
  if (config.dataTransform) {
    seriesValues = seriesValues.map((v: number | null) =>
      v === null ? null : config.dataTransform!(v * 1000) / 1000,
    );
  }

  return seriesValues;
}

/**
 * Calculate rest of house for load mode
 */
function calculateRestOfHouse(
  masterLoadValues: (number | null)[] | null,
  childLoadsSum: (number | null)[] | null,
  batteryChargeValues: (number | null)[] | null,
  gridExportValues: (number | null)[] | null,
  totalGenerationValues: (number | null)[] | null,
): SeriesData | null {
  // Case 1: Master load WITH child loads
  if (masterLoadValues !== null && childLoadsSum !== null) {
    const restOfHouse = masterLoadValues.map(
      (masterLoad: number | null, idx: number) => {
        const childSum = childLoadsSum[idx];
        if (masterLoad === null || childSum === null) return null;
        return Math.max(0, masterLoad - childSum);
      },
    );

    console.log(
      `[Site Processor] Case 1: Added rest of house (master - children)`,
    );
    return {
      id: "rest-of-house",
      description: REST_OF_HOUSE_LABEL,
      data: restOfHouse,
      color: getColorForPath("rest-of-house"),
      // The synthetic remainder is `load.rest-of-house` in the flow matrix (note the differing
      // spelling — the chart id has no `load.` prefix).
      flowPath: "load.rest-of-house",
    };
  }

  // Case 2: Master load WITHOUT child loads - skip
  if (masterLoadValues !== null && childLoadsSum === null) {
    console.log(
      `[Site Processor] Case 2: Master load exists, no children - skipping rest of house`,
    );
    return null;
  }

  // Case 3: No master load, calculate from generation
  if (masterLoadValues === null && totalGenerationValues !== null) {
    const restOfHouse = totalGenerationValues.map(
      (totalGen: number | null, idx: number) => {
        if (totalGen === null) return null;

        const childSum = (childLoadsSum && childLoadsSum[idx]) || 0;
        const batteryCharge =
          (batteryChargeValues && batteryChargeValues[idx]) || 0;
        const gridExport = (gridExportValues && gridExportValues[idx]) || 0;

        return Math.max(0, totalGen - batteryCharge - gridExport - childSum);
      },
    );

    console.log(
      `[Site Processor] Case 3: Added rest of house (generation - battery - grid - children)`,
    );
    return {
      id: "rest-of-house",
      description: REST_OF_HOUSE_LABEL,
      data: restOfHouse,
      color: getColorForPath("rest-of-house"),
      // The synthetic remainder is `load.rest-of-house` in the flow matrix (note the differing
      // spelling — the chart id has no `load.` prefix).
      flowPath: "load.rest-of-house",
    };
  }

  console.log(
    `[Site Processor] Cannot calculate rest of house - insufficient data`,
  );
  return null;
}

/**
 * Track values for rest of house calculation
 */
interface LoadTracker {
  masterLoadValues: (number | null)[] | null;
  childLoadsSum: (number | null)[] | null;
  batteryChargeValues: (number | null)[] | null;
  gridExportValues: (number | null)[] | null;
}

/**
 * Process series for one mode (load or generation)
 */
function processMode(
  mode: "load" | "generation",
  powerSeries: ParsedSeries[],
  socSeries: ParsedSeries[],
  selectedIndices: number[],
  filteredTimestamps: Date[],
  totalGenerationValues: (number | null)[] | null,
): { seriesData: SeriesData[]; newTotalGeneration: (number | null)[] | null } {
  const seriesMap = new Map<string, ParsedSeries>();
  powerSeries.forEach((s) => seriesMap.set(s.id, s));

  const seriesConfig = generateSeriesConfig(powerSeries, mode);
  console.log(
    `[Site Processor] ${mode} - Generated ${seriesConfig.length} configs`,
  );

  const seriesData: SeriesData[] = [];
  const loadTracker: LoadTracker = {
    masterLoadValues: null,
    childLoadsSum: null,
    batteryChargeValues: null,
    gridExportValues: null,
  };

  // Process each configured series
  for (const config of seriesConfig) {
    if (config.id === "rest-of-house" && mode === "load") continue;

    const dataSeries = seriesMap.get(config.id);
    if (!dataSeries) {
      console.log(`[Site Processor] ${mode} - Series not found: ${config.id}`);
      continue;
    }

    const seriesValues = extractSeriesData(dataSeries, selectedIndices, config);

    seriesData.push({
      id: config.id,
      description: config.label,
      data: seriesValues,
      color: config.color,
      // Resolved here (not in the legend table) because `mode` is what disambiguates the grid
      // direction — export and import are the same source series with the same id.
      flowPath: flowPathForSeries(dataSeries.path, mode),
    });

    console.log(`[Site Processor] ${mode} - Added ${config.label}`);

    // Track values for rest of house (load mode only)
    if (mode === "load") {
      trackLoadValues(dataSeries, seriesValues, config, loadTracker);
    }
  }

  // Add rest of house for load mode
  if (mode === "load") {
    const restOfHouse = calculateRestOfHouse(
      loadTracker.masterLoadValues,
      loadTracker.childLoadsSum,
      loadTracker.batteryChargeValues,
      loadTracker.gridExportValues,
      totalGenerationValues,
    );
    if (restOfHouse) {
      // Where the vendor MEASURES the complement, that point is already charted as its own row and
      // has claimed `load.rest-of-house`. The synthetic remainder is then a second, different row
      // (the leftover the measured point doesn't account for) with no flow node of its own — leaving
      // its flowPath set would make it a duplicate of the measured row in the legend table's
      // cost/emissions column, and double-count it in the Total.
      if (seriesData.some((s) => s.flowPath === restOfHouse.flowPath)) {
        restOfHouse.flowPath = undefined;
      }
      seriesData.push(restOfHouse);
    }
  }

  // Calculate total generation for generation mode
  let newTotalGeneration = totalGenerationValues;
  if (mode === "generation" && seriesData.length > 0) {
    newTotalGeneration = new Array(filteredTimestamps.length).fill(0);
    seriesData.forEach((series) => {
      series.data.forEach((val, idx) => {
        if (val !== null && newTotalGeneration![idx] !== null) {
          newTotalGeneration![idx] = (newTotalGeneration![idx] as number) + val;
        } else if (val === null) {
          newTotalGeneration![idx] = null;
        }
      });
    });
    console.log(
      `[Site Processor] Calculated total generation from ${seriesData.length} series`,
    );
  }

  // Add SoC series for generation mode
  if (mode === "generation") {
    addSocSeries(socSeries, selectedIndices, seriesData);
  }

  // Sort by config order
  seriesData.sort((a, b) => {
    const aConfig = seriesConfig.find((c) => c.id === a.id);
    const bConfig = seriesConfig.find((c) => c.id === b.id);
    return (aConfig?.order ?? 999) - (bConfig?.order ?? 999);
  });

  return { seriesData, newTotalGeneration };
}

/**
 * Track load values for rest of house calculation
 */
function trackLoadValues(
  dataSeries: ParsedSeries,
  seriesValues: (number | null)[],
  config: any,
  tracker: LoadTracker,
): void {
  const pointPathStr = dataSeries.seriesPath!.pointPath;
  const segments = stemSplit(pointPathStr);

  if (segments.length === 0) return;

  if (segments[0] === "load") {
    if (segments.length === 1) {
      tracker.masterLoadValues = seriesValues;
      console.log(`[Site Processor] Found master load: ${config.label}`);
    } else {
      if (tracker.childLoadsSum === null) {
        tracker.childLoadsSum = new Array(seriesValues.length).fill(0);
      }
      seriesValues.forEach((val, idx) => {
        if (val !== null && tracker.childLoadsSum![idx] !== null) {
          tracker.childLoadsSum![idx] =
            (tracker.childLoadsSum![idx] as number) + val;
        } else if (val === null) {
          tracker.childLoadsSum![idx] = null;
        }
      });
      console.log(`[Site Processor] Added child load: ${config.label}`);
    }
  } else if (matchesLogicalPath(pointPathStr, "bidi.battery", "power")) {
    tracker.batteryChargeValues = seriesValues;
    console.log(`[Site Processor] Found battery charge: ${config.label}`);
  } else if (matchesLogicalPath(pointPathStr, "bidi.grid", "power")) {
    tracker.gridExportValues = seriesValues;
    console.log(`[Site Processor] Found grid export: ${config.label}`);
  }
}

/**
 * Add SoC series to generation mode
 */
function addSocSeries(
  socSeries: ParsedSeries[],
  selectedIndices: number[],
  seriesData: SeriesData[],
): void {
  socSeries.forEach((soc) => {
    const socValues = selectedIndices.map((i) => soc.history.data[i]);
    const path = soc.path || "";

    let description = "Battery SoC";
    if (path === "bidi.battery/soc.avg") description = "Battery SoC (Avg)";
    else if (path === "bidi.battery/soc.min") description = "Battery SoC (Min)";
    else if (path === "bidi.battery/soc.max") description = "Battery SoC (Max)";

    seriesData.push({
      id: soc.id,
      description,
      data: socValues,
      color: getColorForPath(path, description),
      seriesType: "soc",
    });

    console.log(`[Site Processor] generation - Added SoC: ${description}`);
  });
}

/**
 * How stale a grid rate may be and still apply. Amber's rates are 30-min native, so on the D period's
 * 5-min grid only every 6th bucket carries a value — without a hold, hovering between price boundaries
 * would read "—" five times out of six. 35 min is one native interval plus slack, matching the server's
 * own `RATE_FILL_MS` in `lib/battery-provenance/load.ts`; a genuinely missed tick still reads "—".
 * At the 1d interval the limit never fires, so a hovered day shows only its own average price.
 */
const RATE_FILL_MS = 35 * 60 * 1000;

/**
 * A sparse rate series held forward onto the chart's timestamps. Index-aligned to `timestamps`; a
 * value older than {@link RATE_FILL_MS} (or none yet) reads null.
 *
 * A local re-implementation on purpose: the engine's `forwardFill` lives in
 * `lib/battery-provenance/load.ts`, which pulls the DB in with it and can't be imported here.
 */
export function forwardFillRate(
  timestamps: Date[],
  values: (number | null)[],
): (number | null)[] {
  let lastValue: number | null = null;
  let lastAtMs = 0;
  return timestamps.map((t, i) => {
    const v = values[i] ?? null;
    if (v !== null) {
      lastValue = v;
      lastAtMs = t.getTime();
      return v;
    }
    if (lastValue === null) return null;
    return t.getTime() - lastAtMs <= RATE_FILL_MS ? lastValue : null;
  });
}

/**
 * Shape the raw `bidi.grid.{import,export}/rate` series into {@link ProcessedSiteData.gridRates},
 * windowed to the chart's own timestamps and held forward. Returns null when neither is bound, so
 * "this Area has no prices" stays distinct from "prices exist but not at this instant".
 */
function buildGridRates(
  rateSeries: ParsedSeries[],
  selectedIndices: number[],
  filteredTimestamps: Date[],
): ProcessedSiteData["gridRates"] {
  const pick = (stem: string) => {
    const s = rateSeries.find((r) =>
      matchesLogicalPath(r.seriesPath!.pointPath, stem, "rate"),
    );
    if (!s) return null;
    return forwardFillRate(
      filteredTimestamps,
      selectedIndices.map((i) => s.history.data[i] ?? null),
    );
  };
  const imp = pick("bidi.grid.import");
  const exp = pick("bidi.grid.export");
  if (!imp && !exp) return null;
  const empty = filteredTimestamps.map(() => null);
  return { import: imp ?? empty, export: exp ?? empty };
}

/**
 * Process site data for both load and generation charts
 */
function processSiteData(
  fetchedData: FetchedSiteData,
  rawSeries: ParsedSeries[],
): ProcessedSiteData {
  const {
    powerSeries,
    socSeries,
    hwsSeries,
    rateSeries,
    selectedIndices,
    filteredTimestamps,
    requestInterval,
    requestStart,
    requestEnd,
    flowMatrix,
    attributedFlow,
  } = fetchedData;

  const processedData: ProcessedSiteData = {
    load: null,
    generation: null,
    rawSeries,
    requestStart,
    requestEnd,
    flowMatrix,
    attributedFlow,
    hwsTemperature: hwsSeries[0]
      ? {
          timestamps: filteredTimestamps,
          values: selectedIndices.map((i) => hwsSeries[0].history.data[i]),
        }
      : null,
    gridRates: buildGridRates(rateSeries, selectedIndices, filteredTimestamps),
  };

  // Process generation FIRST (needed for load Case 3)
  const generationResult = processMode(
    "generation",
    powerSeries,
    socSeries,
    selectedIndices,
    filteredTimestamps,
    null,
  );

  processedData.generation = {
    timestamps: filteredTimestamps,
    series: generationResult.seriesData,
    mode: requestInterval === "1d" ? "energy" : "power",
  };

  // Process load mode (uses total generation from above)
  const loadResult = processMode(
    "load",
    powerSeries,
    socSeries,
    selectedIndices,
    filteredTimestamps,
    generationResult.newTotalGeneration,
  );

  processedData.load = {
    timestamps: filteredTimestamps,
    series: loadResult.seriesData,
    mode: requestInterval === "1d" ? "energy" : "power",
  };

  console.log("[Site Processor] === PROCESSED DATA ===", processedData);

  return processedData;
}

/**
 * Main entry point: fetch and process site data
 */
export async function fetchAndProcessSiteData(
  systemId: string,
  period: ChartTimeRange,
  startTime?: string,
  endTime?: string,
): Promise<ProcessedSiteData> {
  const { rawSeries, processable } = await fetchSiteData(
    systemId,
    period,
    startTime,
    endTime,
  );

  if (!processable) {
    return {
      load: null,
      generation: null,
      rawSeries,
    };
  }

  return processSiteData(processable, rawSeries);
}
