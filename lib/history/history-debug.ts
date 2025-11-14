import micromatch from "micromatch";
import { SeriesInfo, getSeriesPath } from "@/lib/point/series-info";

/**
 * Query debug information - can be a simple string or parameterized query
 */
export interface QueryDebugInfo {
  template: string; // SQL template with ? placeholders
  args: (number | string)[]; // Query parameters
}

/**
 * Debug information collected during history query execution
 */
export interface HistoryDebugInfo {
  source?: string; // Data source table name (e.g., "point_readings_agg_5m")
  query: (string | QueryDebugInfo)[]; // SQL queries executed (string for legacy, QueryDebugInfo for parameterized)
  patterns?: string[]; // Series patterns used to filter points
  series: Array<{
    id: string; // Full series ID (e.g. "1/source.solar/power.avg")
    matched?: string; // The first pattern that matched this series
  }>;
}

/**
 * Register a series in the debug info and determine which pattern it matched
 * @param debug - Debug info object (modified in place)
 * @param seriesInfo - SeriesInfo containing point and its aggregation field
 */
export function registerSeries(
  debug: HistoryDebugInfo,
  seriesInfo: SeriesInfo,
): void {
  // Get the full series path
  const seriesPath = getSeriesPath(seriesInfo);
  const seriesId = seriesPath.toString();

  // Determine which pattern matched (if patterns were provided)
  let matchedPattern: string | undefined;
  if (debug.patterns && debug.patterns.length > 0) {
    // Remove system identifier prefix to match against point path patterns
    const pathWithoutSystem = seriesId.substring(seriesId.indexOf("/") + 1);

    // Find first matching pattern
    for (const pattern of debug.patterns) {
      if (micromatch.isMatch(pathWithoutSystem, pattern)) {
        matchedPattern = pattern;
        break;
      }
    }
  }

  debug.series.push({
    id: seriesId,
    matched: matchedPattern,
  });
}
