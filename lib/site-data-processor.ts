import {
  ChartData,
  SeriesData,
  generateSeriesConfig,
} from "@/components/SitePowerChart";
import { getColorForPath } from "@/lib/chart-colors";
import { SeriesPath } from "@/lib/identifiers";
import { parseAbsolute, parseDate, toZoned } from "@internationalized/date";
import { encodeI18nToUrlSafeString } from "@/lib/url-date";

export interface ProcessedSiteData {
  load: ChartData | null;
  generation: ChartData | null;
  requestStart?: string;
  requestEnd?: string;
}

/**
 * Series data from the history API with parsed path
 */
interface ParsedSeries {
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
}> {
  // Build API URL - use absolute time if provided, otherwise use relative
  let apiUrl: string;
  if (startTime && endTime) {
    // Historical data with specific time range
    // Convert ISO timestamps to URL-safe format
    let startEncoded: string;
    let endEncoded: string;

    if (requestInterval === "1d") {
      // For daily intervals, use date-only format (CalendarDate)
      const startDate = parseDate(startTime.split("T")[0]);
      const endDate = parseDate(endTime.split("T")[0]);
      startEncoded = encodeI18nToUrlSafeString(startDate) as string;
      endEncoded = encodeI18nToUrlSafeString(endDate) as string;
    } else {
      // For minute intervals, use ZonedDateTime with UTC timezone
      const startZoned = parseAbsolute(startTime, "UTC");
      const endZoned = parseAbsolute(endTime, "UTC");
      startEncoded = encodeI18nToUrlSafeString(
        toZoned(startZoned, "UTC"),
        true,
      ) as string;
      endEncoded = encodeI18nToUrlSafeString(
        toZoned(endZoned, "UTC"),
        true,
      ) as string;
    }

    apiUrl = `/api/history?interval=${requestInterval}&startTime=${startEncoded}&endTime=${endEncoded}&systemId=${systemId}&series=${seriesFilter}`;
  } else {
    // Current/live data - use relative time
    apiUrl = `/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId}&series=${seriesFilter}`;
  }

  const response = await fetch(apiUrl, {
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch data: ${response.status}`);
  }

  const data = await response.json();

  // Check if we have data
  if (!data || !data.data || !Array.isArray(data.data)) {
    console.warn("No data returned from history API:", data);
    return {
      series: [],
      requestStart: data?.requestStart,
      requestEnd: data?.requestEnd,
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
  };
}

/**
 * Data fetched and prepared for processing
 */
interface FetchedSiteData {
  powerSeries: ParsedSeries[];
  socSeries: ParsedSeries[];
  timestamps: Date[];
  selectedIndices: number[];
  filteredTimestamps: Date[];
  requestInterval: string;
  requestStart?: string;
  requestEnd?: string;
}

/**
 * Split battery power series into charge and discharge
 */
function splitBatteryPower(powerSeries: ParsedSeries[]): ParsedSeries[] {
  const batteryPowerIndex = powerSeries.findIndex((s) =>
    s.seriesPath!.pointPath.matches("bidi.battery", "power"),
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
  period: "1D" | "7D" | "30D",
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

    if (period === "1D") {
      windowHours = 24;
      intervalMinutes = 5;
    } else if (period === "7D") {
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
 * Fetch site data from API and prepare it for processing
 */
async function fetchSiteData(
  systemId: string,
  period: "1D" | "7D" | "30D",
  startTime?: string,
  endTime?: string,
): Promise<FetchedSiteData | null> {
  // Map period to request parameters
  let requestInterval: string;
  let duration: string;

  if (period === "1D") {
    requestInterval = "5m";
    duration = "24h";
  } else if (period === "7D") {
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

  // Fetch and parse all series data
  const {
    series: allSeries,
    requestStart,
    requestEnd,
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
    return null;
  }

  // Separate power and SoC series
  let powerSeries = allSeries.filter((d) => d.type === "power");
  if (powerSeries.length === 0) {
    console.warn("No power series data available in response");
    return null;
  }

  // Split battery power into charge/discharge
  powerSeries = splitBatteryPower(powerSeries);

  // Extract SoC series
  const socSeries = allSeries.filter((d) =>
    d.seriesPath!.pointPath.matches("bidi.battery", "soc"),
  );
  console.log(
    "[Site Processor] Found SoC series:",
    socSeries.map((s) => s.path),
  );
  console.log(
    "[Site Processor] Available series IDs:",
    powerSeries.map((s) => s.id),
  );

  // Calculate timestamps and time window
  const { timestamps, selectedIndices, filteredTimestamps } =
    calculateTimeWindow(powerSeries[0], period, startTime, endTime);

  return {
    powerSeries,
    socSeries,
    timestamps,
    selectedIndices,
    filteredTimestamps,
    requestInterval,
    requestStart,
    requestEnd,
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
      id: "rest_of_house",
      description: "Rest of House",
      data: restOfHouse,
      color: getColorForPath("rest_of_house"),
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
      id: "rest_of_house",
      description: "Rest of House",
      data: restOfHouse,
      color: getColorForPath("rest_of_house"),
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
    if (config.id === "rest_of_house" && mode === "load") continue;

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
    if (restOfHouse) seriesData.push(restOfHouse);
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
  const pointPath = dataSeries.seriesPath!.pointPath;

  if (pointPath.type === "load") {
    if (!pointPath.subtype) {
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
  } else if (pointPath.matches("bidi.battery", "power")) {
    tracker.batteryChargeValues = seriesValues;
    console.log(`[Site Processor] Found battery charge: ${config.label}`);
  } else if (pointPath.matches("bidi.grid", "power")) {
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
 * Process site data for both load and generation charts
 */
function processSiteData(fetchedData: FetchedSiteData): ProcessedSiteData {
  const {
    powerSeries,
    socSeries,
    selectedIndices,
    filteredTimestamps,
    requestInterval,
    requestStart,
    requestEnd,
  } = fetchedData;

  const processedData: ProcessedSiteData = {
    load: null,
    generation: null,
    requestStart,
    requestEnd,
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
  period: "1D" | "7D" | "30D",
  startTime?: string,
  endTime?: string,
): Promise<ProcessedSiteData> {
  const fetchedData = await fetchSiteData(systemId, period, startTime, endTime);

  if (!fetchedData) {
    return {
      load: null,
      generation: null,
    };
  }

  return processSiteData(fetchedData);
}
