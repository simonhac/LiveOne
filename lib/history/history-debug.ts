import micromatch from "micromatch";
import { FlavouredPoint, getSeriesPath } from "@/lib/point/flavoured-point";

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
  points: Array<{
    identifier: string; // e.g. "source.solar"
    flavour: string; // e.g. "power.avg"
    matched?: string; // The first pattern that matched this point
  }>;
}

/**
 * Register a point in the debug info and determine which pattern it matched
 * @param debug - Debug info object (modified in place)
 * @param flavouredPoint - FlavouredPoint containing point and its flavour
 */
export function registerPoint(
  debug: HistoryDebugInfo,
  flavouredPoint: FlavouredPoint,
): void {
  // Build identifier (pointIdentifier, e.g., "source.solar") and flavour
  const identifier = flavouredPoint.point.getIdentifier();
  if (!identifier) return; // Skip if point has no identifier

  const flavour = flavouredPoint.point.getFlavourIdentifier(
    flavouredPoint.flavour.aggregationField,
  );

  // Determine which pattern matched (if patterns were provided)
  let matchedPattern: string | undefined;
  if (debug.patterns && debug.patterns.length > 0) {
    // Get the series path for pattern matching
    const seriesPath = getSeriesPath(flavouredPoint);
    if (seriesPath) {
      // Find first matching pattern
      for (const pattern of debug.patterns) {
        if (micromatch.isMatch(seriesPath, pattern)) {
          matchedPattern = pattern;
          break;
        }
      }
    }
  }

  debug.points.push({
    identifier,
    flavour,
    matched: matchedPattern,
  });
}
