import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SystemsManager, SystemWithPolling } from "@/lib/systems-manager";
import { OpenNEMDataSeries } from "@/types/opennem";
import {
  formatOpenNEMResponse,
  formatDataArray,
} from "@/lib/history/format-opennem";
import {
  formatTimeAEST,
  formatDateAEST,
  parseTimeRange as parseTimeRangeUtil,
  parseDateRange,
  parseRelativeTime,
  getDateDifferenceMs,
  getTimeDifferenceMs,
} from "@/lib/date-utils";
import { CalendarDate, ZonedDateTime, now } from "@internationalized/date";
import { HistoryService } from "@/lib/history/history-service";
import { isUserAdmin } from "@/lib/auth-utils";

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

// ============================================================================
// Types and Interfaces
// ============================================================================

interface AuthResult {
  userId: string;
  isAdmin: boolean;
}

interface SystemAccess {
  system: SystemWithPolling;
  hasAccess: boolean;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
  statusCode?: number;
}

// ============================================================================
// Authentication & Access Control
// ============================================================================

async function authenticateUser(): Promise<AuthResult | NextResponse> {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized - Authentication required" },
      { status: 401 },
    );
  }

  const isAdmin = await isUserAdmin();
  return { userId, isAdmin };
}

async function checkSystemAccess(
  systemId: number,
  userId: string,
  isAdmin: boolean,
): Promise<SystemAccess | NextResponse> {
  const systemsManager = SystemsManager.getInstance();

  try {
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Admin can access all systems, regular users can only access their own
    const hasAccess = isAdmin || system.ownerClerkUserId === userId;

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to system" },
        { status: 403 },
      );
    }

    return { system, hasAccess };
  } catch (error) {
    return NextResponse.json({ error: "System not found" }, { status: 404 });
  }
}

// ============================================================================
// Parameter Parsing & Validation
// ============================================================================

function parseBasicParams(searchParams: URLSearchParams): ValidationResult & {
  systemId?: number;
  interval?: string;
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

  return {
    isValid: true,
    systemId,
    interval,
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
      // Parse absolute time based on interval
      switch (interval) {
        case "1d":
          // For daily intervals, expect date-only strings
          [startTime, endTime] = parseDateRange(startTimeParam, endTimeParam);
          break;

        case "30m":
        case "5m":
          // For minute intervals, accept datetime or date strings
          [startTime, endTime] = parseTimeRangeUtil(
            startTimeParam,
            endTimeParam,
            systemTimezoneOffsetMin,
          );
          break;

        default:
          throw new Error(`Unsupported interval: ${interval}`);
      }
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
): Promise<{ series: OpenNEMDataSeries[]; debug?: any }> {
  // Special handling for craighack systems (combine systems 2 & 3)
  if (system.vendorType === "craighack") {
    // Get both systems' data and combine them
    const systemsManager = SystemsManager.getInstance();

    try {
      const system2 = await systemsManager.getSystem(2);
      const system3 = await systemsManager.getSystem(3);

      if (!system2 || !system3) {
        throw new Error("Unable to fetch craighack systems 2 and 3");
      }

      // Fetch data for both systems (fields are extracted dynamically)
      const [data2, data3] = await Promise.all([
        HistoryService.getHistoryInOpenNEMFormat(
          system2,
          startTime,
          endTime,
          interval,
        ),
        HistoryService.getHistoryInOpenNEMFormat(
          system3,
          startTime,
          endTime,
          interval,
        ),
      ]);

      // Combine all data
      return { series: [...data2, ...data3] };
    } catch (error) {
      console.error("Error fetching craighack data:", error);
      throw error;
    }
  }

  // Special handling for composite systems
  if (system.vendorType === "composite") {
    const systemsManager = SystemsManager.getInstance();

    try {
      const metadata = system.metadata as any;

      // If composite system has no configuration yet, return empty data
      if (!metadata || metadata.version !== 2 || !metadata.mappings) {
        console.log(
          `[Composite History] System ${system.id} has no configuration yet or wrong version, returning empty data`,
        );
        return { series: [] };
      }

      // Check if mappings is empty (all categories have empty arrays)
      const hasAnyMappings = Object.values(metadata.mappings).some(
        (pointRefs) => Array.isArray(pointRefs) && pointRefs.length > 0,
      );
      if (!hasAnyMappings) {
        console.log(
          `[Composite History] System ${system.id} has empty mappings, returning empty data`,
        );
        return { series: [] };
      }

      // Collect all point references (systemId.pointId format)
      const pointRefsMap = new Map<string, string>(); // Maps "systemId.pointId" -> category

      for (const [category, pointRefs] of Object.entries(metadata.mappings)) {
        if (Array.isArray(pointRefs)) {
          for (const pointRef of pointRefs as string[]) {
            // pointRef format: "systemId.pointId" (e.g., "3.1", "2.5")
            const [systemIdStr, pointIdStr] = pointRef.split(".");
            const sourceSystemId = parseInt(systemIdStr);
            const pointId = parseInt(pointIdStr);

            if (!isNaN(sourceSystemId) && !isNaN(pointId)) {
              pointRefsMap.set(pointRef, category);
            } else {
              console.warn(
                `[Composite History] Invalid point reference: ${pointRef}`,
              );
            }
          }
        }
      }

      // Query point_info to resolve all point references in one query
      const { db } = await import("@/lib/db");
      const { pointInfo } = await import("@/lib/db/schema-monitoring-points");
      const { sql } = await import("drizzle-orm");

      // Build WHERE clause to match all point references
      const pointQueries = Array.from(pointRefsMap.keys()).map((pointRef) => {
        const [systemIdStr, pointIdStr] = pointRef.split(".");
        return {
          systemId: parseInt(systemIdStr),
          pointId: parseInt(pointIdStr),
        };
      });

      // Fetch all points in one query
      const conditions = pointQueries.map(
        (p) => sql`(system_id = ${p.systemId} AND id = ${p.pointId})`,
      );
      const pointsData = await db
        .select()
        .from(pointInfo)
        .where(sql`${sql.join(conditions, sql` OR `)}`);

      // Build metadata for each point
      const pointsWithMetadata: Array<{
        systemId: number;
        pointId: number;
        category: string;
        metricType: string;
        displayName: string | null;
        capabilityPath: string;
        aggregationField: "avg" | "last";
        transform: string | null;
      }> = [];

      for (const [pointRef, category] of pointRefsMap.entries()) {
        const [systemIdStr, pointIdStr] = pointRef.split(".");
        const systemId = parseInt(systemIdStr);
        const pointId = parseInt(pointIdStr);

        const point = pointsData.find(
          (p) => p.systemId === systemId && p.id === pointId,
        );

        if (!point) {
          console.warn(
            `[Composite History] Point ${pointRef} not found in point_info`,
          );
          continue;
        }

        if (!point.type) {
          console.warn(
            `[Composite History] Point ${pointRef} has no type defined`,
          );
          continue;
        }

        // Build capability path from type.subtype.extension
        const pathParts = [point.type, point.subtype, point.extension].filter(
          Boolean,
        );
        const capabilityPath = pathParts.join(".");

        // Determine which aggregation field to use based on metric_type
        const aggregationField =
          point.metricType === "power" ? ("avg" as const) : ("last" as const);

        pointsWithMetadata.push({
          systemId,
          pointId,
          category,
          metricType: point.metricType,
          displayName: point.displayName,
          capabilityPath,
          aggregationField,
          transform: point.transform,
        });
      }

      console.log(
        `[Composite History] Points to fetch:`,
        JSON.stringify(
          pointsWithMetadata.map((p) => ({
            ref: `${p.systemId}.${p.pointId}`,
            name: p.displayName,
            path: p.capabilityPath,
            metric: p.metricType,
            field: p.aggregationField,
          })),
          null,
          2,
        ),
      );

      if (pointsWithMetadata.length === 0) {
        console.warn(
          `[Composite History] No valid points resolved from configuration`,
        );
        return { series: [] };
      }

      // Query the appropriate aggregation table based on interval
      // Note: We only have 5m and 1d aggregation tables. For 30m, use 5m table.
      const aggTable =
        interval === "1d" ? "point_readings_agg_1d" : "point_readings_agg_5m"; // Use 5m table for both 5m and 30m intervals

      // Calculate time range in Unix epoch milliseconds (point_readings_agg_* uses milliseconds)
      const startEpoch =
        interval === "1d"
          ? (startTime as CalendarDate).toDate("UTC").getTime()
          : (startTime as ZonedDateTime).toDate().getTime();

      const endEpoch =
        interval === "1d"
          ? (endTime as CalendarDate).toDate("UTC").getTime()
          : (endTime as ZonedDateTime).toDate().getTime();

      // Fetch data for each point
      const { buildSiteIdFromSystem } = await import("@/lib/series-path-utils");
      const allSeries: OpenNEMDataSeries[] = [];

      for (const point of pointsWithMetadata) {
        const sourceSystem = await systemsManager.getSystem(point.systemId);
        if (!sourceSystem) {
          console.warn(
            `[Composite History] System ${point.systemId} not found`,
          );
          continue;
        }

        // Query aggregation table
        let rows = (await db.all(sql`
          SELECT interval_end, ${sql.identifier(point.aggregationField)} as value
          FROM ${sql.identifier(aggTable)}
          WHERE system_id = ${point.systemId}
            AND point_id = ${point.pointId}
            AND interval_end >= ${startEpoch}
            AND interval_end < ${endEpoch}
          ORDER BY interval_end ASC
        `)) as Array<{ interval_end: number; value: number | null }>;

        // Apply transform to all values immediately after query
        rows = rows.map((row) => ({
          interval_end: row.interval_end,
          value: applyTransform(row.value, point.transform),
        }));

        // If we're using 30m interval but querying 5m table, aggregate the data
        if (interval === "30m" && aggTable === "point_readings_agg_5m") {
          const aggregated: Array<{
            interval_end: number;
            value: number | null;
          }> = [];
          const intervalMs = 30 * 60 * 1000; // 30 minutes in ms

          // Group rows by 30-minute buckets
          const buckets = new Map<number, number[]>();

          for (const row of rows) {
            // Round down to nearest 30-minute boundary
            const bucketEnd =
              Math.floor(row.interval_end / intervalMs) * intervalMs +
              intervalMs;

            if (!buckets.has(bucketEnd)) {
              buckets.set(bucketEnd, []);
            }

            if (row.value !== null) {
              buckets.get(bucketEnd)!.push(row.value);
            }
          }

          // Calculate average for each bucket
          for (const [bucketEnd, values] of buckets.entries()) {
            const avg =
              values.length > 0
                ? values.reduce((sum, v) => sum + v, 0) / values.length
                : null;
            aggregated.push({ interval_end: bucketEnd, value: avg });
          }

          // Sort by interval_end
          aggregated.sort((a, b) => a.interval_end - b.interval_end);
          rows = aggregated;
        }

        // Build series ID: liveone.{siteId}.{capabilityPath}.{metricType}.{aggregation}
        const siteId = buildSiteIdFromSystem(sourceSystem);
        const seriesId = `liveone.${siteId}.${point.capabilityPath}.${point.metricType}.${point.aggregationField}`;

        // Format timestamps with system timezone
        const { formatTime_fromJSDate } = await import("@/lib/date-utils");
        const timezoneOffsetMin = system.timezoneOffsetMin ?? 600; // Default to Brisbane (+10:00)

        // Calculate interval parameters for gap filling
        const intervalMs =
          interval === "5m"
            ? 5 * 60 * 1000
            : interval === "30m"
              ? 30 * 60 * 1000
              : 24 * 60 * 60 * 1000; // 1d

        // Build complete data array with gap filling (like opennem-converter.ts does)
        const fieldData: (number | null)[] = [];
        let dataIndex = 0;

        // Walk through all expected intervals
        for (
          let expectedIntervalEnd = startEpoch;
          expectedIntervalEnd < endEpoch;
          expectedIntervalEnd += intervalMs
        ) {
          // Check if we have data for this interval
          if (dataIndex < rows.length) {
            const dataPoint = rows[dataIndex];
            const dataIntervalEnd = dataPoint.interval_end;

            if (dataIntervalEnd === expectedIntervalEnd) {
              // We have data for this interval - apply formatting (4 sig figs)
              const value = dataPoint.value;
              fieldData.push(
                value === null ? null : parseFloat(value.toPrecision(4)),
              );
              dataIndex++;
            } else {
              // No data for this interval
              fieldData.push(null);
            }
          } else {
            // No more data points
            fieldData.push(null);
          }
        }

        // Use query range for start/end (all series should have same time range)
        const startFormatted = formatTime_fromJSDate(
          new Date(startEpoch),
          timezoneOffsetMin,
        );
        const endFormatted = formatTime_fromJSDate(
          new Date(endEpoch - intervalMs),
          timezoneOffsetMin,
        );

        allSeries.push({
          id: seriesId,
          type: "power",
          units: point.metricType === "power" ? "MW" : "",
          path: point.capabilityPath, // Add point path (type.subtype.extension)
          history: {
            start: startFormatted,
            last: endFormatted,
            interval: interval,
            data: fieldData,
          },
        });

        if (rows.length > 0) {
          console.log(
            `[Composite History] Fetched ${rows.length} data points (${fieldData.length} with gap filling) for ${seriesId}`,
          );
        } else {
          console.warn(
            `[Composite History] No data found for point ${point.systemId}.${point.pointId} (${point.capabilityPath}) - returning ${fieldData.length} nulls`,
          );
        }
      }

      console.log(
        `[Composite History] Total: ${allSeries.length} series with data`,
      );

      return {
        series: allSeries,
        debug: {
          pointsQueried: pointsWithMetadata.map((p) => ({
            pointRef: `${p.systemId}.${p.pointId}`,
            path: p.capabilityPath,
            metric: p.metricType,
            field: p.aggregationField,
          })),
        },
      };
    } catch (error) {
      console.error("Error fetching composite data:", error);
      throw error;
    }
  }

  // For all other systems, use the history service which extracts fields dynamically
  const series = await HistoryService.getHistoryInOpenNEMFormat(
    system,
    startTime,
    endTime,
    interval,
  );
  return { series };
}

// ============================================================================
// Response Building
// ============================================================================

function buildResponse(
  dataSeries: OpenNEMDataSeries[],
  startTime: ZonedDateTime | CalendarDate,
  endTime: ZonedDateTime | CalendarDate,
  interval: "5m" | "30m" | "1d",
  debug?: any,
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
    data: dataSeries,
  };

  // Add debug info if provided
  if (debug) {
    response.debug = debug;
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
  try {
    // Step 1: Authentication
    const authResult = await authenticateUser();
    if (authResult instanceof NextResponse) {
      return authResult;
    }

    // Step 2: Parse basic parameters (no fields parameter needed)
    const searchParams = request.nextUrl.searchParams;
    const basicParams = parseBasicParams(searchParams);
    if (!basicParams.isValid) {
      return NextResponse.json(
        { error: basicParams.error },
        { status: basicParams.statusCode! },
      );
    }

    // Step 3: Check system access
    const systemAccess = await checkSystemAccess(
      basicParams.systemId!,
      authResult.userId,
      authResult.isAdmin,
    );
    if (systemAccess instanceof NextResponse) {
      return systemAccess;
    }

    const { system } = systemAccess;

    // Step 4: Parse time range
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

    // Step 5: Validate time range
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

    // Step 6: Fetch data using new abstraction
    const { series: dataSeries, debug } = await getSystemHistoryInOpenNEMFormat(
      system,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as "5m" | "30m" | "1d",
    );

    // Step 7: Build and return response
    return buildResponse(
      dataSeries,
      timeRange.startTime!,
      timeRange.endTime!,
      basicParams.interval as "5m" | "30m" | "1d",
      debug,
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
