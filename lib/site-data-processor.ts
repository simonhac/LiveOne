import {
  ChartData,
  SeriesData,
  generateSeriesConfig,
} from "@/components/SitePowerChart";
import { getColorForPath } from "@/lib/chart-colors";

export interface ProcessedSiteData {
  load: ChartData | null;
  generation: ChartData | null;
  requestStart?: string;
  requestEnd?: string;
}

export async function fetchAndProcessSiteData(
  systemId: string,
  period: "1D" | "7D" | "30D",
  startTime?: string,
  endTime?: string,
): Promise<ProcessedSiteData> {
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

  // Build series filter based on interval
  // For 5m/30m: request power.avg for all series, plus battery SOC.last
  // For 1d: request power.avg for all series, plus battery SOC min/avg/max
  let seriesFilter: string;
  if (requestInterval === "1d") {
    seriesFilter = "*/power.avg,bidi.battery/soc.{min,avg,max}";
  } else {
    seriesFilter = "*/power.avg,bidi.battery/soc.last";
  }

  // Build API URL - use absolute time if provided, otherwise use relative
  let apiUrl: string;
  if (startTime && endTime) {
    // Historical data with specific time range
    // For 1d interval, convert ISO timestamps to YYYY-MM-DD format
    let start = startTime;
    let end = endTime;

    if (requestInterval === "1d") {
      // Extract just the date part (YYYY-MM-DD)
      start = startTime.split("T")[0];
      end = endTime.split("T")[0];
    }

    apiUrl = `/api/history?interval=${requestInterval}&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}&systemId=${systemId}&series=${seriesFilter}`;
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
      load: null,
      generation: null,
      requestStart: data?.requestStart,
      requestEnd: data?.requestEnd,
    };
  }

  // Process the data once for both charts
  let powerSeries = data.data.filter((d: any) => d.type === "power");

  if (powerSeries.length === 0) {
    console.warn("No power series data available in response");
    return {
      load: null,
      generation: null,
      requestStart: data.requestStart,
      requestEnd: data.requestEnd,
    };
  }

  // Split battery power into charge and discharge series
  // Find battery power series (bidi.battery/power.avg or bidi.battery/power.*)
  const batteryPowerIndex = powerSeries.findIndex((s: any) => {
    const isBatteryPower = s.path && s.path.startsWith("bidi.battery/power.");
    return isBatteryPower;
  });

  if (batteryPowerIndex !== -1) {
    const batterySeries = powerSeries[batteryPowerIndex];

    // Create charge series (negative values -> positive)
    const chargeData = batterySeries.history.data.map((v: number | null) =>
      v !== null && v < 0 ? Math.abs(v) : 0,
    );
    const chargeSeries = {
      ...batterySeries,
      id: batterySeries.id.replace("/power.", "/power.charge."),
      path: "bidi.battery.charge",
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
      path: "bidi.battery.discharge",
      label: "Battery Discharge",
      history: {
        ...batterySeries.history,
        data: batterySeries.history.data.map((v: number | null) =>
          v !== null && v > 0 ? v : 0,
        ),
      },
    };

    // Replace the original battery series with charge and discharge
    powerSeries = [
      ...powerSeries.slice(0, batteryPowerIndex),
      chargeSeries,
      dischargeSeries,
      ...powerSeries.slice(batteryPowerIndex + 1),
    ];

    console.log(
      "[Site Processor] Split battery into charge and discharge series",
    );
  } else {
    console.log(
      "[Site Processor] Battery series NOT found - charge/discharge will show as 0",
    );
  }

  // Extract battery SoC series (separate from power series)
  // For 5m/30m: bidi.battery/soc.last
  // For 1d: bidi.battery/soc.avg, bidi.battery/soc.min, bidi.battery/soc.max
  const socSeries = data.data.filter((d: any) => {
    const path = d.path || "";
    return (
      path === "bidi.battery/soc.last" ||
      path === "bidi.battery/soc.avg" ||
      path === "bidi.battery/soc.min" ||
      path === "bidi.battery/soc.max"
    );
  });
  console.log(
    "[Site Processor] Found SoC series:",
    socSeries.map((s: any) => s.path),
  );

  // Create a map of available series by their full ID
  const seriesMap = new Map<string, any>();
  powerSeries.forEach((series: any) => {
    seriesMap.set(series.id, series);
  });
  console.log(
    "[Site Processor] Available series IDs in data:",
    Array.from(seriesMap.keys()),
  );

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

  // Process data for both load and generation modes
  const processedData: ProcessedSiteData = {
    load: null,
    generation: null,
  };

  // Store processed generation data for Case 3 calculation
  let totalGenerationValues: (number | null)[] | null = null;

  // Process each mode - generation MUST be processed first for Case 3 calculation
  const modes: ("load" | "generation")[] = ["generation", "load"];
  modes.forEach((mode) => {
    // Generate series configuration dynamically from available data
    const seriesConfig = generateSeriesConfig(powerSeries, mode);
    console.log(
      `[Site Processor] ${mode} mode - Generated ${seriesConfig.length} series configs:`,
      seriesConfig.map((c) => ({ id: c.id, label: c.label })),
    );
    const seriesData: SeriesData[] = [];

    // For rest of house calculation
    let masterLoadValues: (number | null)[] | null = null; // Master load (path="load")
    let childLoadsSum: (number | null)[] | null = null; // Sum of child loads (path="load.xxx")
    let batteryChargeValues: (number | null)[] | null = null; // Battery charge (negative battery power)
    let gridExportValues: (number | null)[] | null = null; // Grid export (negative grid power)

    // Process each configured series
    seriesConfig.forEach((config) => {
      // Special handling for calculated series
      if (config.id === "rest_of_house" && mode === "load") {
        // We'll calculate this after processing all other series
        return;
      }

      // Find the matching series in our data
      const dataSeries = seriesMap.get(config.id);
      if (!dataSeries) {
        console.log(
          `[Site Processor] ${mode} mode - Series not found in data:`,
          config.id,
        );
        return; // Skip if series not found in data
      }

      // Extract the data for selected indices and convert to kW or kWh based on units
      // Check the units field to determine conversion factor
      const units = dataSeries.units?.toLowerCase() || "";
      let conversionFactor = 1;

      if (units === "w" || units === "wh") {
        // Convert W to kW or Wh to kWh
        conversionFactor = 1000;
      } else if (units === "kw" || units === "kwh") {
        // Already in kW or kWh
        conversionFactor = 1;
      } else {
        // Unknown units - assume W/Wh for backwards compatibility
        conversionFactor = 1000;
      }

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

      seriesData.push({
        id: config.id,
        description: config.label,
        data: seriesValues,
        color: config.color,
      });
      console.log(
        `[Site Processor] ${mode} mode - Added series ${config.label} with ${seriesValues.length} data points`,
      );

      // Accumulate values for rest of house calculation (load mode)
      if (mode === "load") {
        // Use the path attribute from the series data if available
        const path = dataSeries.path || "";
        const [type, subtype] = path.split(".");

        if (path && type === "load") {
          // Path information is available - use it to distinguish master vs child loads
          if (subtype === undefined || subtype === "") {
            // Master load (path = "load" exactly)
            masterLoadValues = seriesValues;
            console.log(`[Site Processor] Found master load: ${config.label}`);
          } else {
            // Child load (path = "load.xxx")
            if (childLoadsSum === null) {
              childLoadsSum = new Array(seriesValues.length).fill(0);
            }
            seriesValues.forEach((val: number | null, idx: number) => {
              if (val !== null && childLoadsSum![idx] !== null) {
                childLoadsSum![idx] = (childLoadsSum![idx] as number) + val;
              } else if (val === null) {
                childLoadsSum![idx] = null;
              }
            });
            console.log(`[Site Processor] Added child load: ${config.label}`);
          }
        } else if (path && type === "bidi" && subtype === "battery") {
          // Battery charge (negative battery power) - capture the transformed values
          batteryChargeValues = seriesValues;
          console.log(
            `[Site Processor] Found battery charge: ${config.label}, path="${path}"`,
          );
        } else if (path && type === "bidi" && subtype === "grid") {
          // Grid export (negative grid power) - capture the transformed values
          gridExportValues = seriesValues;
          console.log(`[Site Processor] Found grid export: ${config.label}`);
        } else if (!path) {
          // No path information - sum ALL loads for Case 3 calculation
          // (All series in load mode are loads by definition)
          if (childLoadsSum === null) {
            childLoadsSum = new Array(seriesValues.length).fill(0);
          }
          seriesValues.forEach((val: number | null, idx: number) => {
            if (val !== null && childLoadsSum![idx] !== null) {
              childLoadsSum![idx] = (childLoadsSum![idx] as number) + val;
            } else if (val === null) {
              childLoadsSum![idx] = null;
            }
          });
        }
      }
    });

    // Calculate rest of house if in load mode
    if (mode === "load") {
      // Case 1: Master load exists WITH child loads
      if (masterLoadValues !== null && childLoadsSum !== null) {
        const master: (number | null)[] = masterLoadValues;
        const children: (number | null)[] = childLoadsSum;

        // Rest of House = Master Load - Sum of Child Loads
        const restOfHouse: (number | null)[] = master.map(
          (masterLoad: number | null, idx: number) => {
            const childSum = children[idx];
            if (masterLoad === null || childSum === null) return null;
            const rest = masterLoad - childSum;
            return Math.max(0, rest); // Don't show negative values
          },
        );

        seriesData.push({
          id: "rest_of_house",
          description: "Rest of House",
          data: restOfHouse,
          color: getColorForPath("rest_of_house"),
        });
        console.log(
          `[Site Processor] Case 1: Added rest of house (master load - child loads)`,
        );
      }
      // Case 2: Master load exists WITHOUT child loads
      else if (masterLoadValues !== null && childLoadsSum === null) {
        console.log(
          `[Site Processor] Case 2: Master load exists but no child loads - skipping rest of house`,
        );
      }
      // Case 3: No master load, but we have generation data
      // Calculate: Rest of House = Total Generation - Battery Charge - Grid Export - Known Child Loads
      else if (masterLoadValues === null && totalGenerationValues !== null) {
        const generation: (number | null)[] = totalGenerationValues;
        const children: (number | null)[] = childLoadsSum || [];
        const batteryCharge: (number | null)[] = batteryChargeValues || [];
        const gridExport: (number | null)[] = gridExportValues || [];

        // Rest of House = Total Generation - Battery Charge - Grid Export - Sum of Known Child Loads
        const restOfHouse: (number | null)[] = generation.map(
          (totalGen: number | null, idx: number) => {
            if (totalGen === null) return null;

            const childSum = children[idx] || 0;
            const batteryChargeVal = batteryCharge[idx] || 0;
            const gridExportVal = gridExport[idx] || 0;

            // If any component is null, treat as 0 for the calculation
            // (We still want to show rest of house even if some components are missing)
            const rest = totalGen - batteryChargeVal - gridExportVal - childSum;
            return Math.max(0, rest); // Don't show negative values
          },
        );

        seriesData.push({
          id: "rest_of_house",
          description: "Rest of House",
          data: restOfHouse,
          color: getColorForPath("rest_of_house"),
        });
        console.log(
          `[Site Processor] Case 3: Added rest of house (generation - battery charge - grid export - known loads)`,
        );
      } else {
        console.log(
          `[Site Processor] Cannot calculate rest of house - insufficient data`,
        );
      }
    }

    // After processing generation mode, calculate total generation for Case 3
    if (mode === "generation" && seriesData.length > 0) {
      // Sum all generation series (already transformed with correct signs)
      totalGenerationValues = new Array(filteredTimestamps.length).fill(0);
      seriesData.forEach((series) => {
        series.data.forEach((val: number | null, idx: number) => {
          if (val !== null && totalGenerationValues![idx] !== null) {
            totalGenerationValues![idx] =
              (totalGenerationValues![idx] as number) + val;
          } else if (val === null) {
            totalGenerationValues![idx] = null;
          }
        });
      });
      console.log(
        `[Site Processor] Calculated total generation from ${seriesData.length} processed series`,
      );
    }

    // Add battery SoC series if available (only for generation mode)
    if (mode === "generation") {
      socSeries.forEach((soc: any) => {
        const path = soc.path || "";

        // Extract and filter SoC data to selected time range
        const socValues = selectedIndices.map((i: number) => {
          const val = soc.history.data[i];
          return val === null ? null : val; // SoC is already in percentage (0-100)
        });

        // Determine description based on path
        let description = "Battery SoC";

        if (path === "bidi.battery/soc.last") {
          description = "Battery SoC";
        } else if (path === "bidi.battery/soc.avg") {
          description = "Battery SoC (Avg)";
        } else if (path === "bidi.battery/soc.min") {
          description = "Battery SoC (Min)";
        } else if (path === "bidi.battery/soc.max") {
          description = "Battery SoC (Max)";
        }

        seriesData.push({
          id: soc.id,
          description: description,
          data: socValues,
          color: getColorForPath(path, description),
          seriesType: "soc",
        });

        console.log(
          `[Site Processor] ${mode} mode - Added SoC series: ${description}`,
        );
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
  });

  return {
    ...processedData,
    requestStart: data.requestStart,
    requestEnd: data.requestEnd,
  };
}
