import { CHART_COLORS, getLoadColor } from "@/lib/chart-colors";
import { stemSplit } from "@/lib/identifiers/logical-path";
import micromatch from "micromatch";

// Series configuration for data-driven approach
interface SeriesConfig {
  id: string;
  label: string;
  color: string;
  dataTransform?: (val: number) => number;
  order?: number;
}

// Filter series by point identifier pattern (glob-style)
// Pattern format: "bidi.battery.charge/power" or "source.solar*/power"
function filterByPointId(
  series: Array<{ id: string; label?: string; path?: string }>,
  pattern: string,
): typeof series {
  return series.filter((s) => s.path && micromatch.isMatch(s.path, pattern));
}

// Find first series matching point identifier pattern
function findByPointId(
  series: Array<{ id: string; label?: string; path?: string }>,
  pattern: string,
) {
  return series.find((s) => s.path && micromatch.isMatch(s.path, pattern));
}

// Color constants are now imported from @/lib/chart-colors

// Generate series configurations dynamically from available data
export function generateSeriesConfig(
  availableSeries: Array<{ id: string; label?: string; path?: string }>,
  mode: "load" | "generation",
): SeriesConfig[] {
  const configs: SeriesConfig[] = [];

  if (mode === "load") {
    // Find all load series
    const loadSeries = availableSeries
      .map((s) => ({ ...s, segments: stemSplit(s.path) }))
      .filter((s) => s.segments[0] === "load");

    // Create config for each load
    loadSeries.forEach((series, idx) => {
      // loadType is everything after "load." (e.g., "hvac", "pool", "hvac.upstairs")
      const loadType = series.segments.slice(1).join(".") || "";
      // Use label from API if available, otherwise capitalize load type
      const label =
        series.label ||
        (loadType
          ? loadType.charAt(0).toUpperCase() + loadType.slice(1)
          : "Load");

      // Get color using centralized function
      const color = getLoadColor(loadType, label, idx);

      configs.push({
        id: series.id,
        label,
        color,
        order: idx,
      });
    });

    // Add rest of house placeholder (after loads, at the bottom of the load stack)
    // Note: label and color are not used - site-data-processor provides full SeriesData
    configs.push({
      id: "rest-of-house",
      label: "", // Not used - comes from site-data-processor
      color: "", // Not used - comes from site-data-processor
      order: loadSeries.length,
    });

    // Add battery charge (already split by site-data-processor)
    const batterySeries = findByPointId(
      availableSeries,
      "bidi.battery.charge/power",
    );
    if (batterySeries) {
      configs.push({
        id: batterySeries.id,
        label: "Battery Charge",
        color: CHART_COLORS.battery.main,
        // No dataTransform needed - site-data-processor already splits and transforms
        order: loadSeries.length + 1,
      });
    }

    // Add grid export (negative grid power)
    const gridSeries = findByPointId(availableSeries, "bidi.grid/power*");
    if (gridSeries) {
      configs.push({
        id: gridSeries.id,
        label: "Grid Export",
        color: CHART_COLORS.grid.main,
        dataTransform: (val: number) => (val < 0 ? Math.abs(val) : 0),
        order: loadSeries.length + 2,
      });
    }
  } else {
    // generation mode
    // Find solar series (matches source.solar, source.solar.local, source.solar.remote, etc.)
    const solarSeries = filterByPointId(availableSeries, "source.solar*/power*")
      .map((s) => ({ ...s, segments: stemSplit(s.path) }))
      .sort((a, b) => {
        // Sort by extension (3rd+ segment): local first, then remote
        const aExt = a.segments.slice(2).join(".") || "";
        const bExt = b.segments.slice(2).join(".") || "";
        return aExt.localeCompare(bExt);
      });

    solarSeries.forEach((series, idx) => {
      // Extension is 3rd+ segment (e.g., "local", "remote")
      const extension = series.segments.slice(2).join(".") || "";
      // Use label from API if available, otherwise derive from path
      const label =
        series.label ||
        (extension
          ? `Solar ${extension.charAt(0).toUpperCase() + extension.slice(1)}`
          : "Solar");
      const color =
        idx === 0 ? CHART_COLORS.solar.primary : CHART_COLORS.solar.secondary;

      configs.push({
        id: series.id,
        label,
        color,
        order: idx,
      });
    });

    // Add battery discharge (already split by site-data-processor)
    const batterySeries = findByPointId(
      availableSeries,
      "bidi.battery.discharge/power",
    );
    if (batterySeries) {
      configs.push({
        id: batterySeries.id,
        label: "Battery Discharge",
        color: CHART_COLORS.battery.main,
        // No dataTransform needed - site-data-processor already splits and transforms
        order: solarSeries.length,
      });
    }

    // Add grid import (positive grid power) - after battery
    const gridSeries = findByPointId(availableSeries, "bidi.grid/power*");
    if (gridSeries) {
      configs.push({
        id: gridSeries.id,
        label: "Grid Import",
        color: CHART_COLORS.grid.main,
        dataTransform: (val: number) => (val > 0 ? val : 0),
        order: solarSeries.length + 1,
      });
    }
  }

  return configs;
}
