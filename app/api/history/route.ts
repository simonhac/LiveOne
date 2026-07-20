import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { SystemWithPolling } from "@/lib/systems-manager";
import { OpenNEMDataSeries } from "@/types/opennem";
import { formatOpenNEMResponse } from "@/lib/history/format-opennem";
import {
  formatTimeAEST,
  formatDateAEST,
  parseRelativeTime,
  getDateDifferenceMs,
  getTimeDifferenceMs,
} from "@/lib/date-utils";
import { decodeUrlSafeStringToI18n } from "@/lib/url-date";
import { CalendarDate, ZonedDateTime, now } from "@internationalized/date";
import { splitBraceAware } from "@/lib/series-filter-utils";
import { HistoryDebugInfo, QueryDebugInfo } from "@/lib/history/history-debug";
import { PointManager } from "@/lib/point/point-manager";
import {
  buildSeriesFromAggRows,
  type AggRow,
} from "@/lib/history/build-series";
import { fetchAggRowsPg } from "@/lib/history/readings-pg";
import {
  resolveLogicalSystem,
  type LogicalSystem,
} from "@/lib/aggregation/logical-system";
import { buildFlowMatrixFromAggRows } from "@/lib/history/build-flow-matrix";
import type { EnergyFlowMatrix } from "@/lib/energy-flow-matrix";

// Initialize manager instances
const pointManager = PointManager.getInstance();

// ============================================================================
// Helper Functions
// ============================================================================

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
  sankey?: { logicalSystem: LogicalSystem },
): Promise<{
  series: OpenNEMDataSeries[];
  debug?: HistoryDebugInfo;
  dataSource?: string;
  sqlQueries?: string[];
  flowMatrix?: EnergyFlowMatrix | null;
  flowMatrixOmittedReason?: string;
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
    return {
      series: [],
      flowMatrixOmittedReason: sankey ? "no-series" : undefined,
    };
  }

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

  // Deduplicate (system_id, point_id) pairs — we select ALL aggregation fields per point.
  const uniquePairsArray: Array<[number, number]> = Array.from(
    new Set(
      seriesInfos.map(
        (series) => `${series.point.systemId},${series.point.index}`,
      ),
    ),
  ).map((pair) => {
    const [systemId, pointId] = pair.split(",").map(Number);
    return [systemId, pointId] as [number, number];
  });

  // Sub-daily Sankey: compute the energy-flow matrix from the SAME signed 5m rows this fetch loads
  // (5m/30m only — for 30m the rows are still raw 5m, bucketed later), so it costs no extra query.
  // Refuse if the fetched series don't cover every role point (a filtered request would otherwise
  // silently mis-derive rest-of-house / residual). The matrix is captured from whichever serve path
  // produces the rows below.
  let flowMatrix: EnergyFlowMatrix | null | undefined;
  let flowMatrixOmittedReason: string | undefined;
  if (sankey) {
    const fetchedAvgPoints = new Set(
      seriesInfos
        .filter((s) => s.aggregationField === "avg")
        .map((s) => `${s.point.systemId}.${s.point.index}`),
    );
    const coversRoleSet = sankey.logicalSystem.points.every((p) =>
      fetchedAvgPoints.has(`${p.ref.systemId}.${p.ref.pointId}`),
    );
    if (!coversRoleSet) flowMatrixOmittedReason = "incomplete-series-set";
  }
  const computeSankey =
    sankey !== undefined && flowMatrixOmittedReason === undefined;

  // Time window: 1d uses YYYY-MM-DD day strings; 5m/30m uses an epoch-ms dense timeline.
  // When aggregating 5m → 30m we fetch 25 min earlier (a 30m bucket needs six 5m readings).
  const startDate =
    interval === "1d" ? (startTime as CalendarDate).toString() : undefined;
  const endDate =
    interval === "1d" ? (endTime as CalendarDate).toString() : undefined;
  const queryFirstEpoch =
    interval === "30m" ? firstEpoch - 25 * 60 * 1000 : firstEpoch;

  // Serve from Postgres: read the window and build the OpenNEM series via the shared transform.
  const rows = await fetchAggRowsPg({
    uniquePairs: uniquePairsArray,
    interval,
    queryFirstEpoch,
    lastEpoch,
    startDate,
    endDate,
  });
  if (computeSankey)
    flowMatrix = buildFlowMatrixFromAggRows(rows, sankey!.logicalSystem);
  const series = await buildSeriesFromAggRows(
    rows,
    seriesInfos,
    interval,
    system,
    firstEpoch,
    lastEpoch,
    debug,
  );

  return {
    series,
    dataSource: aggTable,
    debug,
    flowMatrix,
    flowMatrixOmittedReason,
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
  flowMatrix?: EnergyFlowMatrix | null,
  flowMatrixOmittedReason?: string,
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

  // Add the sub-daily energy-flow matrix (or why it was omitted) when ?include=sankey was requested.
  if (flowMatrix) {
    response.flowMatrix = flowMatrix;
    response.flowMatrixResolution = "5m";
  } else if (flowMatrixOmittedReason) {
    response.flowMatrixOmittedReason = flowMatrixOmittedReason;
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

    // Authenticate and check access (owner/admin/viewer/public, or a valid dashboard share token).
    const authResult = await requireDashboardAccess(
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

    const interval = basicParams.interval as "5m" | "30m" | "1d";

    // Optional energy-flow Sankey bundled with the history payload (?include=sankey). Only sub-daily
    // intervals are computed here (the in-hand signed 5m rows); 1d / long-range is served from the
    // materialized flow-matrix (energy-flow-matrix) endpoint instead.
    const includeParam = searchParams.get("include");
    const includeSankey = includeParam
      ? includeParam
          .split(",")
          .map((s) => s.trim())
          .includes("sankey")
      : false;
    let sankey: { logicalSystem: LogicalSystem } | undefined;
    let sankeyOmittedReason: string | undefined;
    if (includeSankey) {
      if (interval === "1d") {
        sankeyOmittedReason = "1d-served-from-flow-matrix-endpoint";
      } else {
        const logicalSystem = await resolveLogicalSystem(basicParams.systemId!);
        if (!logicalSystem || !logicalSystem.isComplete) {
          sankeyOmittedReason = "not-a-logical-system";
        } else {
          sankey = { logicalSystem };
        }
      }
    }

    // Fetch data using point readings provider
    const {
      series: dataSeries,
      dataSource,
      debug,
      sqlQueries,
      flowMatrix,
      flowMatrixOmittedReason,
    } = await getSystemHistoryInOpenNEMFormat(
      system,
      timeRange.startTime!,
      timeRange.endTime!,
      interval,
      seriesPatterns.length > 0 ? seriesPatterns : undefined,
      basicParams.enableDebug,
      sankey,
    );

    // Build and return response
    const durationMs = Date.now() - startTime;
    return buildResponse(
      dataSeries,
      timeRange.startTime!,
      timeRange.endTime!,
      interval,
      durationMs,
      system.displayTimezone,
      dataSource,
      debug,
      seriesPatterns.length > 0 ? seriesPatterns : undefined,
      sqlQueries,
      flowMatrix,
      includeSankey
        ? (sankeyOmittedReason ?? flowMatrixOmittedReason)
        : undefined,
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
