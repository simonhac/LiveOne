"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ChartTooltip from "./ChartTooltip";
import PeriodSwitcher from "./PeriodSwitcher";
import ServerErrorModal from "./ServerErrorModal";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  ChartOptions,
  Filler,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { format } from "date-fns";
import "chartjs-adapter-date-fns";
import annotationPlugin from "chartjs-plugin-annotation";
import micromatch from "micromatch";

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
  annotationPlugin,
);

interface EnergyChartProps {
  className?: string;
  maxPowerHint?: number; // Max power in kW
  systemId: number; // System ID (e.g., 648, 1586)
  vendorType?: string; // Vendor type (e.g., 'enphase', 'selectronic')
  initialPeriod?: "1D" | "7D" | "30D"; // Initial period from URL
}

interface ChartData {
  timestamps: Date[];
  solar: number[];
  load: number[];
  batteryW: number[];
  batterySOC: number[];
  batterySOCMin?: number[]; // Min SOC for daily data
  batterySOCMax?: number[]; // Max SOC for daily data
  grid?: number[]; // Grid power/energy (optional - not all systems have grid data)
  mode: "power" | "energy"; // Mode based on interval: power (≤30m) or energy (≥1d)
}

export default function EnergyChart({
  className = "",
  maxPowerHint,
  systemId,
  initialPeriod,
}: EnergyChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{
    type: "connection" | "server" | null;
    details?: string;
  }>({ type: null });

  // Track if a fetch is in progress to prevent duplicate fetches
  const fetchInProgressRef = useRef(false);

  // Initialize timeRange from URL param or prop
  const getInitialTimeRange = () => {
    const urlPeriod = searchParams.get("period") as "1D" | "7D" | "30D" | null;
    if (urlPeriod && ["1D", "7D", "30D"].includes(urlPeriod)) {
      return urlPeriod;
    }
    return initialPeriod || "1D";
  };

  const [timeRange, setTimeRange] = useState<"1D" | "7D" | "30D">(
    getInitialTimeRange(),
  );
  const [hoveredData, setHoveredData] = useState<{
    solar: number | null;
    load: number | null;
    battery: number | null;
    grid: number | null;
    batterySOC: number | null;
    timestamp: Date | null;
  }>({
    solar: null,
    load: null,
    battery: null,
    grid: null,
    batterySOC: null,
    timestamp: null,
  });
  const chartRef = useRef<any>(null);

  // Define callbacks before any conditional returns
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleHover = useCallback(
    (event: any, activeElements: any[], chart: any) => {
      // Don't process if no chart data
      if (!chartData) return;

      // Clear any pending timeout
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }

      // Debounce the hover update
      hoverTimeoutRef.current = setTimeout(() => {
        if (activeElements && activeElements.length > 0) {
          const dataIndex = activeElements[0].index;
          const solarValue = chartData.solar[dataIndex]; // Already converted to kW/kWh by convertToKw()
          const loadValue = chartData.load[dataIndex]; // Already converted to kW/kWh by convertToKw()
          const batteryPowerValue =
            chartData.batteryW && chartData.batteryW[dataIndex] !== undefined
              ? chartData.batteryW[dataIndex]
              : null; // Already converted to kW by convertToKw()
          const gridValue =
            chartData.grid && chartData.grid[dataIndex] !== undefined
              ? chartData.grid[dataIndex]
              : null; // Already converted to kW/kWh by convertToKw()
          const batteryValue = chartData.batterySOC[dataIndex];
          const timestamp = chartData.timestamps[dataIndex];

          setHoveredData({
            solar: solarValue,
            load: loadValue,
            battery: batteryPowerValue,
            grid: gridValue,
            batterySOC: batteryValue,
            timestamp: timestamp,
          });
        } else {
          setHoveredData({
            solar: null,
            load: null,
            battery: null,
            grid: null,
            batterySOC: null,
            timestamp: null,
          });
        }
      }, 10); // Small debounce delay
    },
    [chartData],
  );

  // Calculate the time window for x-axis
  const { now, windowStart } = useMemo(() => {
    const now = new Date();
    let windowHours: number;
    if (timeRange === "1D") {
      windowHours = 24;
    } else if (timeRange === "7D") {
      windowHours = 24 * 7;
    } else {
      // 30D
      windowHours = 24 * 30;
    }
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    return { now, windowStart };
  }, [timeRange]);

  const options: ChartOptions<any> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index" as const,
        intersect: false,
      },
      onHover: handleHover,
      plugins: {
        legend: {
          display: false, // Hide the legend
        },
        tooltip: {
          enabled: false, // Disable the default tooltip since we're using our custom one
        },
        annotation: {
          annotations: (() => {
            const annotations: any[] = [];

            if (timeRange === "30D") {
              // For 30D view: shade weekdays (Mon-Fri)
              const daysToShow = 31;
              for (let i = 0; i < daysToShow; i++) {
                const day = new Date(now);
                day.setDate(day.getDate() - i);
                day.setHours(0, 0, 0, 0);

                const dayOfWeek = day.getDay(); // 0 = Sunday, 6 = Saturday

                // Only shade weekdays (Monday = 1 through Friday = 5)
                if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                  const dayEnd = new Date(day);
                  dayEnd.setHours(23, 59, 59, 999);

                  // Only add if this day overlaps with our window
                  if (dayEnd > windowStart && day < now) {
                    annotations.push({
                      type: "box",
                      xMin: Math.max(day.getTime(), windowStart.getTime()),
                      xMax: Math.min(dayEnd.getTime(), now.getTime()),
                      backgroundColor: "rgba(255, 255, 255, 0.07)", // 7% opacity white overlay
                      borderWidth: 0,
                    });
                  }
                }
              }
            } else {
              // For 1D and 7D views: shade daytime hours (7am-10pm)
              const daysToShow = timeRange === "1D" ? 2 : 8;
              for (let i = 0; i < daysToShow; i++) {
                const dayStart = new Date(now);
                dayStart.setDate(dayStart.getDate() - i);
                dayStart.setHours(7, 0, 0, 0);

                const dayEnd = new Date(now);
                dayEnd.setDate(dayEnd.getDate() - i);
                dayEnd.setHours(22, 0, 0, 0);

                // Only add if this day overlaps with our window
                if (dayEnd > windowStart && dayStart < now) {
                  annotations.push({
                    type: "box",
                    xMin: Math.max(dayStart.getTime(), windowStart.getTime()),
                    xMax: Math.min(dayEnd.getTime(), now.getTime()),
                    backgroundColor: "rgba(255, 255, 255, 0.07)", // 7% opacity white overlay
                    borderWidth: 0,
                  });
                }
              }
            }

            return annotations;
          })(),
        },
      },
      scales: {
        x: {
          type: "time",
          min: windowStart.getTime(), // Show from selected time range
          max: now.getTime(), // To current time
          time: {
            unit: timeRange === "1D" ? "hour" : "day",
            displayFormats: {
              hour: "HH:mm",
              day: "MMM d", // Show month and day
            },
          },
          grid: {
            color: "rgb(55, 65, 81)", // gray-700
            display: true,
            drawOnChartArea: true,
            drawTicks: true,
          },
          ticks: {
            color: "rgb(156, 163, 175)", // gray-400
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
              lineHeight: 1.4, // Add spacing between day name and date
            },
            maxRotation: 0, // Keep labels horizontal
            minRotation: 0, // Keep labels horizontal
            align: timeRange !== "1D" ? "start" : "center", // Align labels to the right of the grid line in 7D/30D mode
            padding: timeRange === "30D" ? 6 : 4, // More padding for 30D to prevent collision
            autoSkip: timeRange === "1D", // Only auto-skip for 1D view
            source: "auto", // Let Chart.js generate ticks automatically
            callback: function (value: any, index: any, ticks: any) {
              const date = new Date(value);
              if (timeRange === "30D") {
                // Dynamically adjust based on number of ticks
                // More aggressive skipping for smaller screens
                const totalDays = ticks.length;
                let skipInterval = 2; // Default: show every other day

                if (totalDays > 20) {
                  skipInterval = 3; // Show every 3rd day
                }
                if (totalDays > 25) {
                  skipInterval = 4; // Show every 4th day
                }

                if (index % skipInterval !== 0) {
                  // Use multiple spaces to maintain minimum width
                  return "     "; // 5 spaces to prevent collision detection
                } else {
                  // Show the date label
                  const dayName = format(date, "EEE"); // Mon, Tue, Wed, etc.
                  const dayDate = format(date, "d MMM"); // 30 Jun
                  return [dayName, dayDate]; // Return array for multi-line label
                }
              } else if (timeRange === "7D") {
                // For 7D mode, show day name on first line and date on second line
                const dayName = format(date, "EEE");
                const dayDate = format(date, "d MMM");
                return [dayName, dayDate]; // Return array for multi-line label
              } else if (timeRange === "1D") {
                // For 1D mode, skip some labels to prevent collision
                if (index % 2 !== 0) {
                  return "\u200B"; // Return zero-width space to keep gridline but hide label
                }
                return format(date, "HH:mm");
              }
            },
          },
        },
        y: {
          type: "linear" as const,
          display: true,
          position: "left" as const,
          title: {
            display: false, // Hide the title
          },
          // Use maxPowerHint for power mode, auto-scale for energy mode
          suggestedMax: chartData?.mode === "energy" ? undefined : maxPowerHint,
          // Allow negative values for grid/battery charging
          // min: 0 removed to allow y-axis to go negative
          grid: {
            color: "rgb(55, 65, 81)", // gray-700
            display: true,
            drawOnChartArea: true,
          },
          ticks: {
            color: "rgb(156, 163, 175)", // gray-400
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
            },
            callback: function (value: any, index: any, ticks: any) {
              // Add unit only to the last (top) tick
              // Use kWh for energy mode, kW for power mode
              if (index === ticks.length - 1) {
                const unit = chartData?.mode === "energy" ? "kWh" : "kW";
                return value + " " + unit;
              }
              return value;
            },
          },
        },
        y1: {
          type: "linear" as const,
          display: true,
          position: "right" as const,
          title: {
            display: false, // Hide the title
          },
          grid: {
            display: true,
            drawOnChartArea: false, // Don't draw y1 grid lines on chart area to avoid overlap
          },
          ticks: {
            color: "rgb(156, 163, 175)", // gray-400
            font: {
              size: 10,
              family: "DM Sans, system-ui, sans-serif",
            },
            callback: function (value: any, index: any, ticks: any) {
              // Add "%" only to the last (top) tick
              if (index === ticks.length - 1) {
                return value + "%";
              }
              return value;
            },
          },
          min: 0,
          max: 100,
        },
      },
    }),
    [handleHover, windowStart, now, timeRange, chartData?.mode, maxPowerHint],
  );

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Helper function to build history API URL with series patterns
  const buildHistoryUrl = (
    requestInterval: string,
    duration: string,
    systemId: number,
  ): string => {
    // Build series patterns based on what data we need
    const isEnergyMode = requestInterval === "1d";
    const seriesPatterns: string[] = [];

    if (isEnergyMode) {
      // Daily energy mode - request specific series we use
      seriesPatterns.push(
        "source.solar/energy.delta", // Solar energy
        "load*/energy.delta", // Load energy (includes load, load.hvac, etc.)
        "bidi.grid/energy.delta", // Grid energy
        "bidi.battery/soc.{avg,min,max}", // Battery SOC stats
      );
    } else {
      // 5m/30m power mode - request specific series we use
      seriesPatterns.push(
        "source.solar/power.avg", // Solar power
        "load*/power.avg", // Load power (includes load, load.hvac, etc.)
        "bidi.battery/power.avg", // Battery power
        "bidi.grid/power.avg", // Grid power
        "bidi.battery/soc.last", // Battery SOC
      );
    }

    // Build URL with series patterns (comma-separated)
    // Construct manually to avoid encoding / and , characters
    const seriesParam = seriesPatterns.join(",");
    return `/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId}&series=${seriesParam}`;
  };

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        // Fetch will automatically include cookies
        // Use different intervals based on time range
        let requestInterval: string;
        let duration: string;

        if (timeRange === "1D") {
          requestInterval = "5m";
          duration = "24h"; // 24h for 1D
        } else if (timeRange === "7D") {
          requestInterval = "30m";
          duration = "168h"; // 7*24 for 7D
        } else {
          // 30D
          requestInterval = "1d";
          duration = "30d"; // 30 days
        }

        const isEnergyMode = requestInterval === "1d";

        // Build the URL using the helper function
        const url = buildHistoryUrl(requestInterval, duration, systemId);

        const response = await fetch(url, {
          credentials: "same-origin", // Include cookies
        });

        if (!response.ok) {
          // Check if the response is HTML (like a 404 page) instead of JSON
          const contentType = response.headers.get("content-type");
          if (contentType && !contentType.includes("application/json")) {
            // If we get an HTML response, it's likely a token expiration
            console.log(
              "Non-JSON response received in chart fetch, likely token expired",
            );
            throw new Error("Session expired - please refresh the page");
          }
          if (response.status === 401) {
            throw new Error("Not authenticated - please log in");
          }
          throw new Error(`Failed to fetch data: ${response.status}`);
        }

        const data = await response.json();

        // Ignore response if this effect has been cancelled
        if (cancelled) return;

        // Helper to find series by pattern (glob-style)
        // Pattern format: "bidi.battery/power.avg" or "source.solar*/power.avg"
        const findSeries = (pattern: string) => {
          return data.data.find((d: any) => {
            // Series ID format: {systemId}/{pointPath/metric.aggregation}
            // e.g., "10000/bidi.battery/power.avg" or "daylesford/source.solar.local/power.avg"
            // Extract the series path part (everything after systemId/)
            const slashIndex = d.id.indexOf("/");
            if (slashIndex === -1) return false;
            const seriesPath = d.id.substring(slashIndex + 1);
            return micromatch.isMatch(seriesPath, pattern);
          });
        };

        // Extract series based on mode (energy vs power)
        let solarData,
          loadData,
          batteryWData,
          batterySOCData,
          batterySOCMinData,
          batterySOCMaxData,
          gridData;

        if (isEnergyMode) {
          // Daily energy mode - use energy.delta and SOC stats
          // Use wildcards to match any solar extension (local, remote, etc.)
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
          // 5m/30m power mode - use power.avg and SOC.last
          // Use wildcards to match any solar extension (local, remote, etc.)
          solarData =
            findSeries("source.solar*/power.avg") ||
            findSeries("solar*/power.avg");
          loadData = findSeries("load/power.avg");
          batteryWData = findSeries("bidi.battery/power.avg");
          batterySOCData = findSeries("bidi.battery/soc.last");
          batterySOCMinData = null;
          batterySOCMaxData = null;
          gridData = findSeries("bidi.grid/power.avg");
        }

        if (!solarData) {
          throw new Error("Missing solar data series");
        }
        // Load and battery are optional (e.g., solar-only systems)

        // Parse the start time - the API returns timestamps like "2025-08-16T12:17:53+10:00"
        const startTimeString = solarData.history.firstInterval;

        // JavaScript Date constructor handles timezone offsets correctly
        const startTime = new Date(startTimeString);

        // Parse the interval from the response (e.g., "5m", "1m")
        const interval = solarData.history.interval;
        if (!interval) {
          throw new Error("No interval specified in API response");
        }

        let intervalMs: number;

        if (interval === "1d") {
          intervalMs = 24 * 60 * 60000; // 1 day
        } else if (interval === "30m") {
          intervalMs = 30 * 60000; // 30 minutes
        } else if (interval === "5m") {
          intervalMs = 5 * 60000; // 5 minutes
        } else if (interval === "1m") {
          intervalMs = 60000; // 1 minute
        } else {
          throw new Error(`Unsupported interval: ${interval}`);
        }

        // Calculate timestamps based on start time and actual interval
        const timestamps = solarData.history.data.map(
          (_: any, index: number) =>
            new Date(startTime.getTime() + index * intervalMs),
        );

        // Get data for selected time range
        const currentTime = new Date();
        let windowHours: number;
        if (timeRange === "1D") {
          windowHours = 24;
        } else if (timeRange === "7D") {
          windowHours = 24 * 7;
        } else {
          // 30D
          windowHours = 24 * 30;
        }
        const windowStart = new Date(
          currentTime.getTime() - windowHours * 60 * 60 * 1000,
        );

        // Filter to selected time range
        const selectedIndices = timestamps
          .map((t: Date, i: number) => ({ time: t, index: i }))
          .filter(
            ({ time }: { time: Date; index: number }) =>
              time >= windowStart && time <= currentTime,
          )
          .map(({ index }: { time: Date; index: number }) => index);

        // Helper function to convert values based on units
        const convertToKw = (
          value: number | null,
          units: string,
        ): number | null => {
          if (value === null) return null;
          const unitsLower = units?.toLowerCase() || "";
          // Convert W to kW or Wh to kWh
          if (unitsLower === "w" || unitsLower === "wh") {
            return value / 1000;
          }
          // Already in kW or kWh
          return value;
        };

        setChartData({
          timestamps: selectedIndices.map((i: number) => timestamps[i]),
          solar: selectedIndices.map((i: number) =>
            convertToKw(solarData.history.data[i], solarData.units),
          ),
          load: loadData
            ? selectedIndices.map((i: number) =>
                convertToKw(loadData.history.data[i], loadData.units),
              )
            : selectedIndices.map(() => null),
          batteryW: batteryWData
            ? selectedIndices.map((i: number) =>
                convertToKw(batteryWData.history.data[i], batteryWData.units),
              )
            : selectedIndices.map(() => null),
          batterySOC: batterySOCData
            ? selectedIndices.map((i: number) => batterySOCData.history.data[i])
            : selectedIndices.map(() => null),
          batterySOCMin: batterySOCMinData
            ? selectedIndices.map(
                (i: number) => batterySOCMinData.history.data[i],
              )
            : undefined,
          batterySOCMax: batterySOCMaxData
            ? selectedIndices.map(
                (i: number) => batterySOCMaxData.history.data[i],
              )
            : undefined,
          grid: gridData
            ? selectedIndices.map((i: number) =>
                convertToKw(gridData.history.data[i], gridData.units),
              )
            : undefined,
          mode: isEnergyMode ? "energy" : "power",
        });
        setLoading(false);
        fetchInProgressRef.current = false; // Mark fetch as complete
      } catch (err: any) {
        // Ignore errors if this effect has been cancelled
        if (cancelled) return;

        console.error("Error fetching chart data:", err);

        // Check if it's a network/connection error
        if (err instanceof TypeError && err.message === "Failed to fetch") {
          setServerError({ type: "connection" });
          setError("Unable to connect to server");
        } else if (
          err instanceof Error &&
          err.message.includes("Failed to fetch data:")
        ) {
          // HTTP error (404, 500, etc.)
          setError(err.message);
        } else {
          setError(
            err instanceof Error ? err.message : "Failed to load chart data",
          );
        }
        setLoading(false);
        fetchInProgressRef.current = false; // Mark fetch as complete even on error
      }
    };

    // Check if fetch is already in progress before starting
    if (fetchInProgressRef.current) {
      console.log("[EnergyChart] Skipping initial fetch - already in progress");
    } else {
      fetchInProgressRef.current = true;
      fetchData();
    }

    // Refresh every minute
    const interval = setInterval(() => {
      if (fetchInProgressRef.current) {
        console.log(
          "[EnergyChart] Skipping interval fetch - already in progress",
        );
      } else {
        fetchInProgressRef.current = true;
        fetchData();
      }
    }, 60000);

    // Cleanup function
    return () => {
      cancelled = true;
      clearInterval(interval);
      fetchInProgressRef.current = false; // Reset for next effect run
    };
  }, [timeRange, systemId]);

  // For energy mode, pad the SOC data to extend the fill to chart edges
  const paddedSOCData =
    chartData?.mode === "energy" &&
    chartData.batterySOCMin &&
    chartData.batterySOCMax
      ? (() => {
          // Get the first and last timestamps from the data
          const timestamps = [...chartData.timestamps];
          const firstTime = timestamps[0];
          const lastTime = timestamps[timestamps.length - 1];

          // Add padding timestamps (half day before/after to ensure coverage)
          const paddedTimestamps = [
            new Date(firstTime.getTime() - 12 * 60 * 60 * 1000), // 12 hours before
            ...timestamps,
            new Date(lastTime.getTime() + 12 * 60 * 60 * 1000), // 12 hours after
          ];

          // Extend the SOC values (use the same values at edges)
          const paddedSOCMin = [
            chartData.batterySOCMin[0],
            ...chartData.batterySOCMin,
            chartData.batterySOCMin[chartData.batterySOCMin.length - 1],
          ];

          const paddedSOCMax = [
            chartData.batterySOCMax[0],
            ...chartData.batterySOCMax,
            chartData.batterySOCMax[chartData.batterySOCMax.length - 1],
          ];

          return {
            timestamps: paddedTimestamps,
            min: paddedSOCMin,
            max: paddedSOCMax,
          };
        })()
      : null;

  const data: any = !chartData
    ? {}
    : chartData.mode === "energy"
      ? {
          // Energy mode: Use bar chart data structure
          labels: chartData.timestamps,
          datasets: [
            {
              label: "Solar",
              data: chartData.solar, // Already in kWh for energy mode
              backgroundColor: "rgb(250, 204, 21)", // yellow-400 solid
              borderWidth: 0, // No border
              yAxisID: "y",
              barPercentage: 0.9,
              categoryPercentage: 0.8,
            },
            {
              label: "Load",
              data: chartData.load, // Already in kWh for energy mode
              backgroundColor: "rgb(96, 165, 250)", // blue-400 solid
              borderWidth: 0, // No border
              yAxisID: "y",
              barPercentage: 0.9,
              categoryPercentage: 0.8,
            },
            // Add battery power if available (for energy mode, this would be battery energy)
            ...(chartData.batteryW
              ? [
                  {
                    label: "Battery",
                    data: chartData.batteryW, // Already in kWh for energy mode
                    backgroundColor: "rgb(251, 146, 60)", // orange-400 solid
                    borderWidth: 0, // No border
                    yAxisID: "y",
                    barPercentage: 0.9,
                    categoryPercentage: 0.8,
                  },
                ]
              : []),
            // Add grid if available
            ...(chartData.grid
              ? [
                  {
                    label: "Grid",
                    data: chartData.grid, // Already in kWh for energy mode
                    backgroundColor: "rgb(239, 68, 68)", // red-500 solid
                    borderWidth: 0, // No border
                    yAxisID: "y",
                    barPercentage: 0.9,
                    categoryPercentage: 0.8,
                  },
                ]
              : []),
            // Add SOC range area if we have min/max data
            ...(paddedSOCData
              ? [
                  {
                    label: "Battery SOC Range",
                    type: "line" as const,
                    labels: paddedSOCData.timestamps,
                    data: paddedSOCData.timestamps.map((t, i) => ({
                      x: t,
                      y: paddedSOCData.max[i],
                    })), // Upper boundary with padding
                    borderColor: "transparent",
                    backgroundColor: "rgba(74, 222, 128, 0.3)", // green-400 with 30% opacity
                    yAxisID: "y1",
                    tension: 0.4, // Nice curved splines
                    borderWidth: 0,
                    pointRadius: 0, // No dots
                    pointHoverRadius: 0, // No dots on hover
                    pointHitRadius: 0, // No hit area for points
                    fill: "+1", // Fill to next dataset (min line)
                    showLine: true,
                    clip: false, // Don't clip at chart edges
                    order: 10, // Higher number = drawn first (behind everything)
                  },
                  {
                    label: "", // No label for min line (hidden from legend)
                    type: "line" as const,
                    labels: paddedSOCData.timestamps,
                    data: paddedSOCData.timestamps.map((t, i) => ({
                      x: t,
                      y: paddedSOCData.min[i],
                    })), // Lower boundary with padding
                    borderColor: "transparent",
                    backgroundColor: "transparent",
                    yAxisID: "y1",
                    tension: 0.4, // Nice curved splines
                    borderWidth: 0,
                    pointRadius: 0, // No dots
                    pointHoverRadius: 0, // No dots on hover
                    pointHitRadius: 0, // No hit area for points
                    fill: false,
                    showLine: true,
                    clip: false, // Don't clip at chart edges
                    order: 10, // Higher number = drawn first (behind everything)
                  },
                ]
              : []),
            {
              label: "Battery SOC",
              type: "line" as const, // Keep SOC as line even in bar chart
              data: chartData.batterySOC, // Already in percentage
              borderColor: "rgb(74, 222, 128)", // green-400
              backgroundColor: "rgb(74, 222, 128)", // Solid color for legend
              yAxisID: "y1",
              tension: 0.1,
              borderWidth: 2,
              pointRadius: 0,
              fill: false, // Don't fill under the line
              order: -1, // Negative number = drawn last (on top of everything)
            },
          ],
        }
      : {
          // Power mode: Use line chart data structure
          labels: chartData.timestamps,
          datasets: [
            {
              label: "Solar",
              data: chartData.solar, // Already converted to kW by convertToKw()
              borderColor: "rgb(250, 204, 21)", // yellow-400
              backgroundColor: "rgb(250, 204, 21)", // Solid color for legend
              yAxisID: "y",
              tension: 0.1,
              borderWidth: 2,
              pointRadius: 0,
              fill: false, // Don't fill under the line
            },
            {
              label: "Load",
              data: chartData.load, // Already converted to kW by convertToKw()
              borderColor: "rgb(96, 165, 250)", // blue-400
              backgroundColor: "rgb(96, 165, 250)", // Solid color for legend
              yAxisID: "y",
              tension: 0.1,
              borderWidth: 2,
              pointRadius: 0,
              fill: false, // Don't fill under the line
            },
            // Add battery power if available
            ...(chartData.batteryW
              ? [
                  {
                    label: "Battery",
                    data: chartData.batteryW, // Already converted to kW by convertToKw()
                    borderColor: "rgb(251, 146, 60)", // orange-400
                    backgroundColor: "rgb(251, 146, 60)", // Solid color for legend
                    yAxisID: "y",
                    tension: 0.1,
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false, // Don't fill under the line
                  },
                ]
              : []),
            // Add grid if available
            ...(chartData.grid
              ? [
                  {
                    label: "Grid",
                    data: chartData.grid, // Already converted to kW by convertToKw()
                    borderColor: "rgb(239, 68, 68)", // red-500
                    backgroundColor: "rgb(239, 68, 68)", // Solid color for legend
                    yAxisID: "y",
                    tension: 0.1,
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false, // Don't fill under the line
                  },
                ]
              : []),
            {
              label: "Battery SOC",
              data: chartData.batterySOC, // Already in percentage
              borderColor: "rgb(74, 222, 128)", // green-400
              backgroundColor: "rgb(74, 222, 128)", // Solid color for legend
              yAxisID: "y1",
              tension: 0.1,
              borderWidth: 2,
              pointRadius: 0,
              fill: false, // Don't fill under the line
            },
          ],
        };

  // Format timestamp based on time range
  const formatHoverTimestamp = (
    date: Date | null,
    isMobile: boolean = false,
  ) => {
    if (!date) return "";

    if (timeRange === "30D") {
      // For 30D view, show date only
      // Mobile: "Fri, 22 Aug" / Desktop: "Fri, 22 Aug 2024"
      return format(date, isMobile ? "EEE, d MMM" : "EEE, d MMM yyyy");
    } else if (timeRange === "7D") {
      // For 7D view, show date and time
      // Mobile: "Fri, 22 Aug 11:58PM" / Desktop: "Fri, 22 Aug 2024 11:58PM"
      return format(
        date,
        isMobile ? "EEE, d MMM h:mma" : "EEE, d MMM yyyy h:mma",
      );
    } else {
      // For 1D view, show time only (e.g., "11:58PM")
      return format(date, "h:mma");
    }
  };

  // Render the chart content based on state
  const renderChartContent = () => {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-gray-500">Loading chart...</div>
        </div>
      );
    }

    if (error || !chartData) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-red-400">
            Error: {error || "No data available"}
          </div>
        </div>
      );
    }

    // Normal chart display
    return (
      <>
        <div className="flex-1 min-h-0">
          {chartData.mode === "energy" ? (
            <Bar ref={chartRef} data={data} options={options} />
          ) : (
            <Line ref={chartRef} data={data} options={options} />
          )}
        </div>
        <div className="flex justify-center mt-2 px-2 sm:px-0">
          <ChartTooltip
            solar={hoveredData.solar}
            load={hoveredData.load}
            battery={hoveredData.battery}
            grid={hoveredData.grid}
            batterySOC={hoveredData.batterySOC}
            unit={chartData?.mode === "energy" ? "kWh" : "kW"}
            visible={true}
          />
        </div>
      </>
    );
  };

  return (
    <div
      className={`md:bg-gray-800 md:border md:border-gray-700 md:rounded py-1 px-0 md:p-4 flex flex-col ${className}`}
    >
      <div className="flex justify-end items-center mb-2 md:mb-3 px-1 md:px-0">
        <div className="flex items-center gap-2 sm:gap-3">
          <span
            className="hidden sm:block text-xs text-gray-400 min-w-[200px] text-right whitespace-nowrap"
            style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
          >
            {formatHoverTimestamp(hoveredData.timestamp)}
          </span>
          <span
            className="sm:hidden text-xs text-gray-400 text-right whitespace-nowrap"
            style={{ fontFamily: "DM Sans, system-ui, sans-serif" }}
          >
            {formatHoverTimestamp(hoveredData.timestamp, true)}
          </span>
          <PeriodSwitcher
            value={timeRange}
            onChange={(newPeriod) => {
              setTimeRange(newPeriod);
              // Update URL with new period
              const params = new URLSearchParams(searchParams.toString());
              params.set("period", newPeriod);
              router.push(`?${params.toString()}`, { scroll: false });
            }}
          />
        </div>
      </div>
      {renderChartContent()}

      <ServerErrorModal
        isOpen={serverError.type !== null}
        onClose={() => setServerError({ type: null })}
        errorType={serverError.type}
        errorDetails={serverError.details}
      />
    </div>
  );
}
