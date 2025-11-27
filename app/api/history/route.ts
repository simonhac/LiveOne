import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { SystemsManager, SystemWithPolling } from "@/lib/systems-manager";
import { OpenNEMDataSeries } from "@/types/opennem";
import { formatOpenNEMResponse } from "@/lib/history/format-opennem";
import {
  formatTimeAEST,
  formatDateAEST,
  parseRelativeTime,
  getDateDifferenceMs,
  getTimeDifferenceMs,
  formatTime_fromJSDate,
} from "@/lib/date-utils";
import { decodeUrlSafeStringToI18n } from "@/lib/url-date";
import { CalendarDate, ZonedDateTime, now } from "@internationalized/date";
import { splitBraceAware } from "@/lib/series-filter-utils";
import { HistoryDebugInfo, registerSeries } from "@/lib/history/history-debug";
import { PointManager } from "@/lib/point/point-manager";
import { getSeriesPath } from "@/lib/point/series-info";

// Initialize manager instances
const pointManager = PointManager.getInstance();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Apply transform to a numeric value based on the transform type
 * - null or 'n': no transform (return original value)
 * - 'i': invert (multiply by -1)
 */
function applyTransform(
  value: number | null,
  transform: string | null,
): number | null {
  if (value === null) return null;
  if (!transform || transform === "n") return value;
  if (transform === "i") return -value;
  return value;
}

/**
 * Validate glob patterns for series filtering
 * @param patterns - Array of glob patterns to validate (parsed from comma-separated string)
 * @returns Validation result with error message if invalid
 */
function validateSeriesPatterns(patterns: string[]): {
  valid: boolean;
  error?: string;
} {
  if (patterns.length === 0) {
    return { valid: true };
  }

  // Validate each pattern
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];

    // Check pattern length (prevent extremely long patterns)
    if (pattern.length > 200) {
      return {
        valid: false,
        error: `Series pattern ${i + 1} too long (max 200 characters)`,
      };
    }

    // Micromatch handles glob patterns safely, no additional validation needed
  }

  return { valid: true };
}

// ============================================================================
// Types and Interfaces
// ============================================================================

interface ValidationResult {
  isValid: boolean;
  error?: string;
  statusCode?: number;
}

// ============================================================================
// Parameter Parsing & Validation
// ============================================================================

function parseBasicParams(searchParams: URLSearchParams): ValidationResult & {
  systemId?: number;
  interval?: string;
  enableDebug?: boolean;
} {
  const systemIdParam = searchParams.get("systemId");
  if (!systemIdParam) {
    return {
      isValid: false,
      error: "Missing required parameter: systemId",
      statusCode: 400,
    };
  }

  const systemId = parseInt(systemIdParam);
  if (isNaN(systemId)) {
    return {
      isValid: false,
      error: "Invalid systemId: must be a number",
      statusCode: 400,
    };
  }

  const interval = searchParams.get("interval");
  if (!interval) {
    return {
      isValid: false,
      error:
        "Missing required parameter: interval. Must be one of: 5m, 30m, 1d",
      statusCode: 400,
    };
  }

  if (!["5m", "30m", "1d"].includes(interval)) {
    return {
      isValid: false,
      error: "Only 5m, 30m, and 1d intervals are supported",
      statusCode: 501,
    };
  }

  // Debug defaults to true, can be disabled with debug=false
  const debugParam = searchParams.get("debug");
  const enableDebug = debugParam === null || debugParam === "true";

  return {
    isValid: true,
    systemId,
    interval,
    enableDebug,
  };
}

function parseTimeRangeParams(
  searchParams: URLSearchParams,
  interval: "5m" | "30m" | "1d",
  systemTimezoneOffsetMin: number,
): ValidationResult & {
  startTime?: ZonedDateTime | CalendarDate;
  endTime?: ZonedDateTime | CalendarDate;
} {
  const lastParam = searchParams.get("last");
  const startTimeParam = searchParams.get("startTime");
  const endTimeParam = searchParams.get("endTime");
  const timezoneOffsetParam = searchParams.get("timezoneOffset");

  let startTime: ZonedDateTime | CalendarDate;
  let endTime: ZonedDateTime | CalendarDate;

  try {
    if (lastParam) {
      // Parse relative time
      [startTime, endTime] = parseRelativeTime(
        lastParam,
        interval,
        systemTimezoneOffsetMin,
      );
    } else if (startTimeParam && endTimeParam) {
      // Parse timezone offset if provided, otherwise use system timezone
      const offsetMin = timezoneOffsetParam
        ? parseInt(timezoneOffsetParam)
        : systemTimezoneOffsetMin;

      // Decode URL-safe strings to CalendarDate or ZonedDateTime
      // The function automatically determines the format based on the string
      startTime = decodeUrlSafeStringToI18n(startTimeParam, offsetMin);
      endTime = decodeUrlSafeStringToI18n(endTimeParam, offsetMin);
    } else {
      return {
        isValid: false,
        error:
          'Missing time range. Provide either "last" parameter (e.g., last=7d) or both "startTime" and "endTime" parameters',
        statusCode: 400,
      };
    }
  } catch (error) {
    return {
      isValid: false,
      error:
        error instanceof Error
          ? error.message
          : "Invalid time range parameters",
      statusCode: 400,
    };
  }

  return {
    isValid: true,
    startTime,
    endTime,
  };
}

function validateTimeRange(
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: "5m" | "30m" | "1d",
): ValidationResult {
  let timeDiff: number;

  switch (interval) {
    case "1d": {
      // For CalendarDate, validate and calculate day difference
      const start = startTime as CalendarDate;
      const end = endTime as CalendarDate;

      if (start.compare(end) > 0) {
        return {
          isValid: false,
          error: "startTime must be before endTime",
          statusCode: 400,
        };
      }

      timeDiff = getDateDifferenceMs(start, end);
      break;
    }

    case "30m":
    case "5m": {
      // For ZonedDateTime, validate and calculate millisecond difference
      const start = startTime as ZonedDateTime;
      const end = endTime as ZonedDateTime;

      if (start.compare(end) >= 0) {
        return {
          isValid: false,
          error: "startTime must be before endTime",
          statusCode: 400,
        };
      }

      // Validate alignment with interval boundaries
      const intervalMinutes = interval === "30m" ? 30 : 5;

      // Check if start time is aligned to interval boundary
      const startMinute = start.minute;
      const startSecond = start.second;
      if (startSecond !== 0 || startMinute % intervalMinutes !== 0) {
        return {
          isValid: false,
          error: `Start time must be aligned to ${intervalMinutes}-minute boundaries (e.g., HH:00:00, HH:${intervalMinutes.toString().padStart(2, "0")}:00)`,
          statusCode: 400,
        };
      }

      // Check if end time is aligned to interval boundary
      const endMinute = end.minute;
      const endSecond = end.second;
      if (endSecond !== 0 || endMinute % intervalMinutes !== 0) {
        return {
          isValid: false,
          error: `End time must be aligned to ${intervalMinutes}-minute boundaries (e.g., HH:00:00, HH:${intervalMinutes.toString().padStart(2, "0")}:00)`,
          statusCode: 400,
        };
      }

      timeDiff = getTimeDifferenceMs(start, end);
      break;
    }

    default:
      return {
        isValid: false,
        error: `Unsupported interval: ${interval}`,
        statusCode: 400,
      };
  }

  // Check time range limits
  const limits = {
    "5m": { duration: 7.5 * 24 * 60 * 60 * 1000, label: "7.5 days" },
    "30m": { duration: 30 * 24 * 60 * 60 * 1000, label: "30 days" },
    "1d": { duration: 13 * 30 * 24 * 60 * 60 * 1000, label: "13 months" },
  };

  const { duration: maxDuration, label: maxDurationLabel } = limits[interval];

  if (timeDiff > maxDuration) {
    return {
      isValid: false,
      error: `Time range exceeds maximum of ${maxDurationLabel} for ${interval} interval`,
      statusCode: 400,
    };
  }

  return { isValid: true };
}

// ============================================================================
// Data Fetching using new abstraction
// ============================================================================

async function getSystemHistoryInOpenNEMFormat(
  system: SystemWithPolling,
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: "5m" | "30m" | "1d",
  filterPatterns?: string[],
  enableDebug?: boolean,
): Promise<{
  series: OpenNEMDataSeries[];
  debug?: HistoryDebugInfo;
  dataSource?: string;
  sqlQueries?: string[];
}> {
  // Get filtered SeriesInfo[] from PointManager
  // Note: PointManager only supports "5m" | "1d" intervals, so for "30m" we use "5m"
  const intervalForFiltering = interval === "30m" ? "5m" : interval;

  const seriesInfos = await pointManager.getSeriesForSystem(
    system,
    filterPatterns,
    intervalForFiltering,
  );

  if (seriesInfos.length === 0) {
    return { series: [] };
  }

  // Setup database query
  const { rawClient } = await import("@/lib/db");
  const aggTable =
    interval === "1d" ? "point_readings_agg_1d" : "point_readings_agg_5m";
  const firstEpoch =
    interval === "1d"
      ? (startTime as CalendarDate).toDate("UTC").getTime()
      : (startTime as ZonedDateTime).toDate().getTime();
  const lastEpoch =
    interval === "1d"
      ? (endTime as CalendarDate).toDate("UTC").getTime()
      : (endTime as ZonedDateTime).toDate().getTime();

  // Initialize debug if enabled
  const debug: HistoryDebugInfo | undefined = enableDebug
    ? {
        source: aggTable,
        query: [],
        patterns: filterPatterns,
        series: [],
      }
    : undefined;

  // Build single batched query for all points
  // We'll query all rows for all points in one go using CTE with VALUES
  // Deduplicate pairs since we select ALL aggregation fields for each point
  const uniquePairsArray = Array.from(
    new Set(
      seriesInfos.map(
        (series) => `${series.point.systemId},${series.point.index}`,
      ),
    ),
  ).map((pair: string) => pair.split(",").map(Number));

  // Build parameterized query with placeholders
  // LibSQL supports positional parameters with ?, so we'll build (?, ?), (?, ?)...
  const pairsPlaceholders = uniquePairsArray.map(() => "(?, ?)").join(", ");

  // Flatten the pairs array for the args parameter
  const pairArgs = uniquePairsArray.flat();

  // Get the aggregation field to query - we need to handle all aggregation fields used
  // For simplicity in the batched query, we'll SELECT all common aggregation fields
  // and filter/use them based on each SeriesInfo's aggregationField
  let queryTemplate: string;
  let queryArgs: (number | string)[];
  let allRows: Array<{
    system_id: number;
    point_id: number;
    interval_end?: number;
    day?: string;
    avg?: number | null;
    min?: number | null;
    max?: number | null;
    last?: number | null;
    delta?: number | null;
    data_quality?: string | null;
  }>;

  if (interval === "1d") {
    const startDate = (startTime as CalendarDate).toString();
    const endDate = (endTime as CalendarDate).toString();

    queryTemplate = `
      WITH pairs(system_id, point_id) AS (
        VALUES ${pairsPlaceholders}
      )
      SELECT
        pra.system_id,
        pra.point_id,
        pra.day,
        pra.avg,
        pra.min,
        pra.max,
        pra.last,
        pra.delta,
        pra.data_quality
      FROM ${aggTable} AS pra
      JOIN pairs p
        ON p.system_id = pra.system_id
       AND p.point_id = pra.point_id
      WHERE pra.day >= ? AND pra.day <= ?
      ORDER BY pra.system_id, pra.point_id, pra.day
    `;

    queryArgs = [...pairArgs, startDate, endDate];

    allRows = (
      await rawClient.execute({
        sql: queryTemplate,
        args: queryArgs,
      })
    ).rows as unknown as typeof allRows;
  } else {
    // When aggregating 5m data to 30m, we need to fetch earlier data
    // For 30m bucket ending at 00:30, we need 5m data from 00:05-00:30 (6 readings)
    // That's 25 minutes earlier: 30m - 5m = 25m
    const queryFirstEpoch =
      interval === "30m" ? firstEpoch - 25 * 60 * 1000 : firstEpoch;

    queryTemplate = `
      WITH RECURSIVE
        timeline AS (
          -- Generate dense timeline at 5-minute intervals
          SELECT ? as interval_end
          UNION ALL
          SELECT interval_end + 300000
          FROM timeline
          WHERE interval_end < ?
        ),
        pairs(system_id, point_id) AS (
          VALUES ${pairsPlaceholders}
        )
      SELECT
        t.interval_end,
        p.system_id,
        p.point_id,
        pra.avg,
        pra.min,
        pra.max,
        pra.last,
        pra.delta,
        pra.data_quality
      FROM timeline t
      CROSS JOIN pairs p
      LEFT JOIN ${aggTable} AS pra
        ON pra.system_id = p.system_id
       AND pra.point_id = p.point_id
       AND pra.interval_end = t.interval_end
      ORDER BY p.system_id, p.point_id, t.interval_end
    `;

    queryArgs = [queryFirstEpoch, lastEpoch, ...pairArgs];

    allRows = (
      await rawClient.execute({
        sql: queryTemplate,
        args: queryArgs,
      })
    ).rows as unknown as typeof allRows;
  }

  if (debug) {
    // Store query template and parameters separately for debugging
    // Normalize whitespace: replace newlines and multiple spaces with single spaces
    const normalizedTemplate = queryTemplate
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .replace(/"/g, "'")
      .trim();

    debug.query.push({
      template: normalizedTemplate,
      args: queryArgs,
    } as any);
  }

  // Group rows by (system_id, point_id, aggregation_field)
  const rowsByPointAndField = new Map<
    string,
    Array<{ interval_end: number; value: number | string | null }>
  >();

  for (const row of allRows) {
    // Convert day to interval_end if needed
    const intervalEnd =
      row.interval_end ?? new Date(row.day! + "T00:00:00Z").getTime();

    // Process each aggregation field (including NULLs from dense timeline)
    // With CTE-generated dense timeline, we always have rows even if data is NULL
    for (const field of [
      "avg",
      "min",
      "max",
      "last",
      "delta",
      "quality",
    ] as const) {
      // Map field name to database column (quality -> data_quality)
      const dbField = field === "quality" ? "data_quality" : field;

      // Always add an entry for this field (value may be null)
      const key = `${row.system_id}.${row.point_id}.${field}`;
      if (!rowsByPointAndField.has(key)) {
        rowsByPointAndField.set(key, []);
      }
      rowsByPointAndField.get(key)!.push({
        interval_end: intervalEnd,
        value: row[dbField] ?? null,
      });
    }
  }

  // Build series for each SeriesInfo
  const { formatTime_fromJSDate } = await import("@/lib/date-utils");
  const systemsManager = SystemsManager.getInstance();
  const allSeries: OpenNEMDataSeries[] = [];

  const intervalMs =
    interval === "5m"
      ? 5 * 60 * 1000
      : interval === "30m"
        ? 30 * 60 * 1000
        : 24 * 60 * 60 * 1000;

  for (const series of seriesInfos) {
    const key = `${series.point.systemId}.${series.point.index}.${series.aggregationField}`;
    let rows = rowsByPointAndField.get(key) || [];

    // Apply transform (skip for quality which is a string)
    if (series.aggregationField !== "quality") {
      rows = rows.map((row) => ({
        interval_end: row.interval_end,
        value: applyTransform(
          row.value as number | null,
          series.point.transform,
        ),
      }));
    }

    // Handle 30m aggregation if needed
    if (interval === "30m" && aggTable === "point_readings_agg_5m") {
      if (series.aggregationField === "quality") {
        // For quality (string values), take the last value in each 30m bucket
        const aggregated: Array<{
          interval_end: number;
          value: string | null;
        }> = [];
        const buckets = new Map<
          number,
          Array<{ interval_end: number; value: string }>
        >();

        for (const row of rows) {
          // Align bucketing to request boundaries
          // Use ceil to round readings UP to the next bucket boundary
          const bucketIndex = Math.ceil(
            (row.interval_end - firstEpoch) / intervalMs,
          );
          const bucketEnd = firstEpoch + bucketIndex * intervalMs;

          if (!buckets.has(bucketEnd)) {
            buckets.set(bucketEnd, []);
          }

          if (row.value !== null) {
            buckets.get(bucketEnd)!.push({
              interval_end: row.interval_end,
              value: row.value as string,
            });
          }
        }

        // Take the last (most recent) quality value in each bucket
        for (const [bucketEnd, values] of buckets.entries()) {
          if (values.length > 0) {
            // Sort by interval_end and take the last one
            values.sort((a, b) => a.interval_end - b.interval_end);
            aggregated.push({
              interval_end: bucketEnd,
              value: values[values.length - 1].value,
            });
          }
        }

        aggregated.sort((a, b) => a.interval_end - b.interval_end);
        rows = aggregated;
      } else {
        // For numeric values, average them
        const aggregated: Array<{
          interval_end: number;
          value: number | null;
        }> = [];
        const buckets = new Map<number, number[]>();

        for (const row of rows) {
          // Align bucketing to request boundaries
          // Use ceil to round readings UP to the next bucket boundary
          const bucketIndex = Math.ceil(
            (row.interval_end - firstEpoch) / intervalMs,
          );
          const bucketEnd = firstEpoch + bucketIndex * intervalMs;

          if (!buckets.has(bucketEnd)) {
            buckets.set(bucketEnd, []);
          }

          if (row.value !== null) {
            buckets.get(bucketEnd)!.push(row.value as number);
          }
        }

        for (const [bucketEnd, values] of buckets.entries()) {
          const avg =
            values.length > 0
              ? values.reduce((sum, v) => sum + v, 0) / values.length
              : null;
          aggregated.push({ interval_end: bucketEnd, value: avg });
        }

        aggregated.sort((a, b) => a.interval_end - b.interval_end);
        rows = aggregated;
      }
    }

    // Get source system for series ID
    const sourceSystem = await systemsManager.getSystem(series.point.systemId);
    if (!sourceSystem) continue;

    // Build series ID using SeriesPath
    const seriesPath = getSeriesPath(series);
    const seriesId = seriesPath.toString();

    // Build field data - database CTE provides dense timeline with NULLs for gaps
    const fieldData: (number | string | null)[] = rows.map((row) => {
      const value = row.value;
      // For quality (string), push as-is; for numbers, apply precision
      if (typeof value === "string") {
        return value;
      } else {
        return value === null ? null : parseFloat(value.toPrecision(4));
      }
    });

    // Build path for the series (e.g., "bidi.battery/power.avg")
    const pointPath =
      series.point.getLogicalPath() ||
      `${series.point.index}/${series.point.metricType}`;
    const fullPath = `${pointPath}.${series.aggregationField}`;

    // Format timestamps
    const timezoneOffsetMin = system.timezoneOffsetMin ?? 600;
    const startFormatted = formatTime_fromJSDate(
      new Date(firstEpoch),
      timezoneOffsetMin,
    );
    const endFormatted = formatTime_fromJSDate(
      new Date(lastEpoch),
      timezoneOffsetMin,
    );

    allSeries.push({
      id: seriesId,
      type: "power",
      units: series.point.metricUnit,
      path: fullPath,
      history: {
        firstInterval: startFormatted,
        lastInterval: endFormatted,
        interval: interval,
        numIntervals: fieldData.length,
        data: fieldData,
      },
    });

    // Register series for debug tracking
    if (debug) {
      registerSeries(debug, series);
    }
  }

  return {
    series: allSeries,
    dataSource: aggTable,
    debug,
  };
}

// ============================================================================
// Response Building
// ============================================================================

function buildResponse(
  dataSeries: OpenNEMDataSeries[],
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: "5m" | "30m" | "1d",
  durationMs: number,
  displayTimezone?: string | null,
  dataSource?: string,
  debug?: any,
  seriesPatterns?: string[],
  sqlQueries?: string[],
): NextResponse {
  // Format date strings based on interval type
  let requestStartStr: string;
  let requestEndStr: string;

  switch (interval) {
    case "1d":
      requestStartStr = formatDateAEST(startTime as CalendarDate);
      requestEndStr = formatDateAEST(endTime as CalendarDate);
      break;

    case "30m":
    case "5m":
      requestStartStr = formatTimeAEST(startTime as ZonedDateTime);
      requestEndStr = formatTimeAEST(endTime as ZonedDateTime);
      break;

    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }

  const response: any = {
    type: "energy",
    version: "v4.1",
    network: "liveone",
    created_at: formatTimeAEST(now("Australia/Brisbane")),
    requestStart: requestStartStr,
    requestEnd: requestEndStr,
    durationMs,
    data: dataSeries,
  };

  // Add displayTimezone if provided
  if (displayTimezone) {
    response.displayTimezone = displayTimezone;
  }

  // Add dataSource if provided
  if (dataSource) {
    response.dataSource = dataSource;
  }

  // Add debug info if provided
  if (debug) {
    response.debug = debug;
  }

  // Add SQL queries if provided (legacy support)
  if (sqlQueries && sqlQueries.length > 0) {
    response.sqlQueries = sqlQueries;
  }

  const jsonStr = formatOpenNEMResponse(response);

  return new NextResponse(jsonStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

// ============================================================================
// Main Handler
// ============================================================================

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  try {
    // Parse basic parameters (systemId, interval, debug)
    const searchParams = request.nextUrl.searchParams;
    const basicParams = parseBasicParams(searchParams);
    if (!basicParams.isValid) {
      return NextResponse.json(
        { error: basicParams.error },
        { status: basicParams.statusCode! },
      );
    }

    // Authenticate and check system access
    const authResult = await requireSystemAccess(
      request,
      basicParams.systemId!,
    );
    if (authResult instanceof NextResponse) return authResult;
    const { system } = authResult;

    // Parse time range
    const timeRange = parseTimeRangeParams(
      searchParams,
      basicParams.interval as "5m" | "30m" | "1d",
      system.timezoneOffsetMin,
    );
    if (!timeRange.isValid) {
      return NextResponse.json(
        { error: timeRange.error },
        { status: timeRange.statusCode! },
      );
    }

    // Validate time range
    const validation = validateTimeRange(
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as "5m" | "30m" | "1d",
    );
    if (!validation.isValid) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.statusCode! },
      );
    }

    // Parse series patterns (comma-separated with brace expansion support)
    // series parameter allows glob-based filtering of which series to fetch
    // Format: ?series=pattern1,pattern2,pattern3
    // Supports brace expansion: ?series=bidi.battery/soc.{avg,min,max}
    const seriesParam = searchParams.get("series");
    const seriesPatterns = seriesParam ? splitBraceAware(seriesParam) : [];

    if (seriesPatterns.length > 0) {
      const validation = validateSeriesPatterns(seriesPatterns);
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
    }

    // Fetch data using point readings provider
    const {
      series: dataSeries,
      dataSource,
      debug,
      sqlQueries,
    } = await getSystemHistoryInOpenNEMFormat(
      system,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as "5m" | "30m" | "1d",
      seriesPatterns.length > 0 ? seriesPatterns : undefined,
      basicParams.enableDebug,
    );

    // Build and return response
    const durationMs = Date.now() - startTime;
    return buildResponse(
      dataSeries,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as "5m" | "30m" | "1d",
      durationMs,
      system.displayTimezone,
      dataSource,
      debug,
      seriesPatterns.length > 0 ? seriesPatterns : undefined,
      sqlQueries,
    );
  } catch (error) {
    console.error("Error fetching historical data:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
