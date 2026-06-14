/**
 * Shared Chart.js scaffolding for the dashboard time-series charts (the lines + stacked charts).
 *
 * These two charts grew up separately but share ~70% of their Chart.js setup verbatim. This
 * module is the first extraction of that duplicated scaffold (phase 1 of the chart-generalization,
 * see docs/plans/chart-card-generalization.md) — pure, framework-agnostic helpers with no behaviour
 * change. The genuinely-divergent parts (the y-axes, the dataset builders) stay in DashboardChart.
 */
import { format } from "date-fns";
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
  Filler,
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";

export type ChartTimeRange = "1D" | "7D" | "30D";

let registered = false;

/**
 * Register the Chart.js elements/plugins both dashboard charts need. Idempotent — safe to call at
 * each component's module load (Chart.js's own register is idempotent too, but the guard avoids the
 * repeated work).
 */
export function registerChartScaffold(): void {
  if (registered) return;
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
  registered = true;
}

/**
 * The background shading boxes shared by both charts: weekday (Mon–Fri) columns for the 30D view,
 * daytime (07:00–22:00) columns for 1D/7D. Returns chartjs-plugin-annotation `box` specs, clipped
 * to the [windowStart, now] window. Callers may append their own annotations (e.g. a hover line).
 */
export function buildShadingAnnotations(
  timeRange: ChartTimeRange,
  now: Date,
  windowStart: Date,
): any[] {
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
}

/**
 * The shared time x-axis scale config: a `time` axis spanning [windowStart, now] with the period-
 * dependent tick formatting both charts use (multi-line weekday labels for 7D/30D, HH:mm for 1D,
 * with the same auto-skip/collision rules). Returned as a plain Chart.js scale object so each
 * component can drop it straight into `scales.x`.
 */
export function buildTimeScale(
  timeRange: ChartTimeRange,
  now: Date,
  windowStart: Date,
): any {
  return {
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
            return "​"; // Return zero-width space to keep gridline but hide label
          }
          return format(date, "HH:mm");
        }
      },
    },
  };
}

/**
 * Format a hovered timestamp for the chart header, shared by both charts: date-only for 30D,
 * date+time for 7D, time-only for 1D; `isMobile` drops the year. Returns "" for a null date.
 */
export function formatHoverTimestamp(
  date: Date | null,
  timeRange: ChartTimeRange,
  isMobile: boolean = false,
): string {
  if (!date) return "";

  if (timeRange === "30D") {
    // Mobile: "Fri, 22 Aug" / Desktop: "Fri, 22 Aug 2024"
    return format(date, isMobile ? "EEE, d MMM" : "EEE, d MMM yyyy");
  } else if (timeRange === "7D") {
    // Mobile: "Fri, 22 Aug 11:58PM" / Desktop: "Fri, 22 Aug 2024 11:58PM"
    return format(
      date,
      isMobile ? "EEE, d MMM h:mma" : "EEE, d MMM yyyy h:mma",
    );
  } else {
    // For 1D view, show time only (e.g., "11:58PM")
    return format(date, "h:mma");
  }
}
