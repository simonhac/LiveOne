import {
  ChartData,
  SeriesData,
  generateSeriesConfig,
  parseSeriesId,
} from "@/components/MondoPowerChart";

export interface ProcessedMondoData {
  load: ChartData | null;
  generation: ChartData | null;
  requestStart?: string;
  requestEnd?: string;
}

export async function fetchAndProcessMondoData(
  systemId: string,
  period: "1D" | "7D" | "30D",
  startTime?: string,
  endTime?: string,
): Promise<ProcessedMondoData> {
  // Map period to request parameters
  let requestInterval: string;
  let duration: string;
  let durationMs: number;

  if (period === "1D") {
    requestInterval = "5m";
    duration = "24h";
    durationMs = 24 * 60 * 60 * 1000;
  } else if (period === "7D") {
    requestInterval = "30m";
    duration = "168h";
    durationMs = 7 * 24 * 60 * 60 * 1000;
  } else {
    requestInterval = "1d";
    duration = "30d";
    durationMs = 30 * 24 * 60 * 60 * 1000;
  }

  // Build API URL - use absolute time if provided, otherwise use relative
  let apiUrl: string;
  if (startTime && endTime) {
    // Historical data with specific time range
    apiUrl = `/api/history?interval=${requestInterval}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&systemId=${systemId}`;
  } else {
    // Current/live data - use relative time
    apiUrl = `/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId}`;
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
      load: null,
      generation: null,
      requestStart: data?.requestStart,
      requestEnd: data?.requestEnd,
    };
  }

  // Process the data once for both charts
  const powerSeries = data.data.filter((d: any) => d.type === "power");

  if (powerSeries.length === 0) {
    console.warn("No power series data available in response");
    return {
      load: null,
      generation: null,
      requestStart: data.requestStart,
      requestEnd: data.requestEnd,
    };
  }

  // Create a map of available series by their full ID
  const seriesMap = new Map<string, any>();
  powerSeries.forEach((series: any) => {
    seriesMap.set(series.id, series);
  });

  // Get first available series to extract timestamps
  const firstSeries = powerSeries[0];
  if (!firstSeries) {
    console.warn("No first series found");
    return {
      load: null,
      generation: null,
      requestStart: data.requestStart,
      requestEnd: data.requestEnd,
    };
  }

  const startTimeString = firstSeries.history.start;
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

  // Filter to selected time range
  let windowStart: Date;
  let windowEnd: Date;

  if (startTime && endTime) {
    // Use the requested time range when explicitly provided
    windowStart = new Date(startTime);
    windowEnd = new Date(endTime);
    console.log(
      "[Mondo Processor] Historical mode - using explicit time range",
    );
    console.log("  windowStart:", windowStart.toISOString());
    console.log("  windowEnd:", windowEnd.toISOString());
    console.log("  dataStartTime:", dataStartTime.toISOString());
    console.log("  First timestamp:", timestamps[0]?.toISOString());
    console.log(
      "  Last timestamp:",
      timestamps[timestamps.length - 1]?.toISOString(),
    );
  } else {
    // Use current time window for live/default view
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

    // Round down the current time to the nearest interval boundary
    const currentMinutes = currentTime.getMinutes();
    const roundedMinutes =
      Math.floor(currentMinutes / intervalMinutes) * intervalMinutes;
    windowEnd = new Date(currentTime);
    windowEnd.setMinutes(roundedMinutes, 0, 0); // Round to interval boundary

    // Start exactly windowHours before the end time
    windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  }

  const selectedIndices = timestamps
    .map((t: Date, i: number) => ({ time: t, index: i }))
    .filter(
      ({ time }: { time: Date; index: number }) =>
        time >= windowStart && time <= windowEnd,
    )
    .map(({ index }: { time: Date; index: number }) => index);

  console.log("[Mondo Processor] Filtering results:");
  console.log("  Total timestamps:", timestamps.length);
  console.log("  Selected indices:", selectedIndices.length);

  const filteredTimestamps = selectedIndices.map((i: number) => timestamps[i]);

  // Process data for both load and generation modes
  const processedData: ProcessedMondoData = {
    load: null,
    generation: null,
  };

  // Process each mode
  const modes: ("load" | "generation")[] = ["load", "generation"];
  modes.forEach((mode) => {
    // Generate series configuration dynamically from available data
    const seriesConfig = generateSeriesConfig(powerSeries, mode);
    const seriesData: SeriesData[] = [];

    // For rest of house calculation
    let measuredLoadsSum: (number | null)[] | null = null;
    let batteryChargeValues: (number | null)[] | null = null;
    let gridExportValues: (number | null)[] | null = null;
    let totalGenerationValues: (number | null)[] | null = null;

    // Process each configured series
    seriesConfig.forEach((config) => {
      // Special handling for calculated series
      if (config.id === "rest_of_house" && mode === "load") {
        // We'll calculate this after processing all other series
        return;
      }

      // Find the matching series in our data
      const dataSeries = seriesMap.get(config.id);
      if (!dataSeries) return; // Skip if series not found in data

      // Extract the data for selected indices and convert from W to kW
      let seriesValues = selectedIndices.map((i: number) => {
        const val = dataSeries.history.data[i];
        return val === null ? null : val / 1000; // Convert W to kW
      });

      // Apply any data transformation
      if (config.dataTransform) {
        seriesValues = seriesValues.map((v: number | null) =>
          v === null ? null : config.dataTransform!(v * 1000) / 1000,
        );
      }

      seriesData.push({
        id: config.id,
        description: config.label,
        data: seriesValues,
        color: config.color,
      });

      // Accumulate values for rest of house calculation (load mode)
      if (mode === "load") {
        const parsed = parseSeriesId(config.id);
        if (parsed?.type === "load") {
          // This is a measured load
          if (measuredLoadsSum === null) {
            measuredLoadsSum = new Array(seriesValues.length).fill(0);
          }
          seriesValues.forEach((val: number | null, idx: number) => {
            if (val !== null && measuredLoadsSum![idx] !== null) {
              measuredLoadsSum![idx] = (measuredLoadsSum![idx] as number) + val;
            } else if (val === null) {
              measuredLoadsSum![idx] = null;
            }
          });
        } else if (
          parsed?.type === "bidi" &&
          parsed?.subtype === "battery" &&
          config.label === "Battery Charge"
        ) {
          batteryChargeValues = seriesValues;
        } else if (
          parsed?.type === "bidi" &&
          parsed?.subtype === "grid" &&
          config.label === "Grid Export"
        ) {
          gridExportValues = seriesValues;
        }
      }

      // Accumulate total generation (generation mode)
      if (mode === "generation") {
        const parsed = parseSeriesId(config.id);
        if (parsed?.type === "source" && parsed?.subtype === "solar") {
          if (totalGenerationValues === null) {
            totalGenerationValues = new Array(seriesValues.length).fill(0);
          }
          seriesValues.forEach((val: number | null, idx: number) => {
            if (val !== null && totalGenerationValues![idx] !== null) {
              totalGenerationValues![idx] =
                (totalGenerationValues![idx] as number) + val;
            } else if (val === null) {
              totalGenerationValues![idx] = null;
            }
          });
        }
      }
    });

    // Calculate rest of house if in load mode
    if (mode === "load" && measuredLoadsSum) {
      // Find solar, grid, and battery series using the new structure
      const solarSeriesList = Array.from(seriesMap.values()).filter((s) => {
        const parsed = parseSeriesId(s.id);
        return parsed?.type === "source" && parsed?.subtype === "solar";
      });

      const gridSeries = Array.from(seriesMap.values()).find((s) => {
        const parsed = parseSeriesId(s.id);
        return parsed?.type === "bidi" && parsed?.subtype === "grid";
      });

      const battSeries = Array.from(seriesMap.values()).find((s) => {
        const parsed = parseSeriesId(s.id);
        return parsed?.type === "bidi" && parsed?.subtype === "battery";
      });

      const totalGeneration = selectedIndices.map((i: number) => {
        // Sum all solar arrays
        let totalSolar = 0;
        let hasNullSolar = false;
        for (const solarSeries of solarSeriesList) {
          const solarRaw = solarSeries.history.data[i];
          if (solarRaw === null || solarRaw === undefined) {
            hasNullSolar = true;
            break;
          }
          totalSolar += solarRaw / 1000; // Convert W to kW
        }

        const gridIn = gridSeries ? gridSeries.history.data[i] : null;
        const battOut = battSeries ? battSeries.history.data[i] : null;

        // Convert W to kW and handle nulls
        let total = totalSolar;
        let hasAnyData = totalSolar > 0;

        // Grid import: positive values mean importing from grid
        if (gridIn !== null && gridIn !== undefined && gridIn > 0) {
          total += gridIn / 1000;
          hasAnyData = true;
        }
        // Battery discharge: positive values mean discharging
        if (battOut !== null && battOut !== undefined && battOut > 0) {
          total += battOut / 1000;
          hasAnyData = true;
        }

        return hasAnyData && !hasNullSolar ? total : null;
      });

      // Calculate rest of house
      // Rest of House = Total Generation - Measured Loads - Battery Charge - Grid Export
      const restOfHouse = totalGeneration.map(
        (gen: number | null, idx: number) => {
          const measured = measuredLoadsSum![idx];
          const batteryCharge = batteryChargeValues![idx];
          const gridExport = gridExportValues![idx];

          // If we don't have generation or measured loads data, return null
          if (gen === null || measured === null) return null;

          // Battery charge and grid export might be null (treat as 0)
          const battCharge =
            batteryCharge !== null && batteryCharge !== undefined
              ? batteryCharge
              : 0;
          const gridExp =
            gridExport !== null && gridExport !== undefined ? gridExport : 0;

          const rest = gen - measured - battCharge - gridExp;
          return Math.max(0, rest); // Don't show negative values
        },
      );

      seriesData.push({
        id: "rest_of_house",
        description: "Rest of House",
        data: restOfHouse,
        color: "rgb(107, 114, 128)", // gray-500
      });
    }

    // Sort series by order from config
    seriesData.sort((a, b) => {
      const aConfig = seriesConfig.find((c) => c.id === a.id);
      const bConfig = seriesConfig.find((c) => c.id === b.id);
      return (aConfig?.order ?? 999) - (bConfig?.order ?? 999);
    });

    processedData[mode] = {
      timestamps: filteredTimestamps,
      series: seriesData,
      mode: requestInterval === "1d" ? "energy" : "power",
    };
    console.log(`[Mondo Processor] ${mode} chart data:`, {
      timestamps: filteredTimestamps.length,
      series: seriesData.length,
      seriesNames: seriesData.map((s) => s.id),
      sampleDataPoint: seriesData[0]?.data.slice(0, 5),
    });
  });

  return {
    ...processedData,
    requestStart: data.requestStart,
    requestEnd: data.requestEnd,
  };
}
