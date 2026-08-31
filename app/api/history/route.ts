import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import {
  resolveWireAddress,
  subjectDisplayTimezone,
  subjectTimezoneOffsetMin,
} from "@/lib/dashboard/subject";
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
import { fetchAggRowsPg, type AggFetchPoint } from "@/lib/history/readings-pg";
import { Point, type PointId } from "@/lib/ids";
import {
  resolveLogicalSystem,
  type LogicalSystem,
} from "@/lib/aggregation/logical-system";
import { buildSeriesListing } from "@/lib/history/list-series";
import { buildAttributedFlowWindow } from "@/lib/history/attributed-window";
import { readAttributedDailyMatrices } from "@/lib/aggregation/flow-attr-read";
import { planetscaleDb } from "@/lib/db/planetscale";
import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";
import {
  makeTimer,
  serverTimingHeaders,
  type ServerTimer,
} from "@/lib/server-timing";

// Initialize manager instances
const pointManager = PointManager.getInstance();

/**
 * Short-TTL memo over `resolveLogicalSystem` — the role→point mapping is near-static config (it
 * changes only on an area/binding edit) yet was re-read from the DB on every sankey request, and
 * twice on some paths. Instance-scoped (per warm serverless instance) and deliberately short, so a
 * config edit is visible within seconds; an in-flight promise is shared, a rejected one is evicted.
 */
const LOGICAL_TTL_MS = 30_000;
const logicalCache = new Map<
  number,
  { at: number; value: Promise<LogicalSystem | null> }
>();
function cachedLogicalSystem(handle: number): Promise<LogicalSystem | null> {
  const hit = logicalCache.get(handle);
  const now = Date.now();
  if (hit && now - hit.at < LOGICAL_TTL_MS) return hit.value;
  const value = resolveLogicalSystem(handle);
  value.catch(() => logicalCache.delete(handle));
  logicalCache.set(handle, { at: now, value });
  return value;
}

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

/**
 * Interval + debug. The SUBJECT is not parsed here — `resolveWireAddress` owns the
 * `areaId`/`deviceId`/`systemId` grammar (config-v4 Phase 13 PR 1) because two of the three need an
 * async `legacy_handles` / `devices.rid` lookup.
 */
function parseBasicParams(searchParams: URLSearchParams): ValidationResult & {
  interval?: string;
  enableDebug?: boolean;
} {
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
    interval,
    enableDebug,
  };
}

function parseTimeRangeParams(
  searchParams: URLSearchParams,
  interval: "5m" | "30m" | "1d",
  deviceTimezoneOffsetMin: number,
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
        deviceTimezoneOffsetMin,
      );
    } else if (startTimeParam && endTimeParam) {
      // Parse timezone offset if provided, otherwise use system timezone
      const offsetMin = timezoneOffsetParam
        ? parseInt(timezoneOffsetParam)
        : deviceTimezoneOffsetMin;

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

  // Per-request range caps. These bound the IN-MEMORY cost, not the SQL: sub-daily reads are one
  // indexed (point_rid, interval_end) range scan of agg_5m, but readings-pg.ts then densifies to a
  // full 5m grid in JS — one object per 5m slot per series (30m has no rollup table; it re-buckets
  // the dense 5m grid). 13 months at 30m ≈ 114k slots/series, fine for a series=-filtered request
  // (the operator CLI's long-history path) and tolerable for an unfiltered area; if this ever
  // hurts, the fix is a real 30m rollup table, not a lower cap. 5m stays modest because its native
  // payload is 6× denser and no caller needs a long window at that resolution.
  const limits = {
    "5m": { duration: 31 * 24 * 60 * 60 * 1000, label: "31 days" },
    "30m": { duration: 13 * 30 * 24 * 60 * 60 * 1000, label: "13 months" },
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

async function getDeviceHistoryInOpenNEMFormat(
  /**
   * The integer addressing handle, and the subject's UTC offset. Phase 13 PR 2: this took the legacy
   * device-shaped view (`synthesizeAreaView`'s fabrication for an Area) and read only `.id` and
   * `.timezoneOffsetMin` off it — so it takes those two directly, and an Area now supplies its own.
   */
  handle: number,
  timezoneOffsetMin: number,
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

  const seriesInfos = await pointManager.getSeriesForDevice(
    handle,
    filterPatterns,
    intervalForFiltering,
  );

  if (seriesInfos.length === 0) {
    return { series: [] };
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

  // Deduplicate points — we select ALL aggregation fields per point. Deduped on the point's own
  // identity (`point_uid` is unique) rather than a stringified address, and each entry carries that
  // identity through so the fetch needs no registry round trip (config-v4 Phase 12 slice D).
  const uniquePairsArray: AggFetchPoint[] = [];
  const seenPoints = new Set<PointId>();
  for (const series of seriesInfos) {
    const point = Point.encode(series.point.pointUid);
    if (seenPoints.has(point)) continue;
    seenPoints.add(point);
    uniquePairsArray.push({
      point,
      systemId: series.point.systemId,
      pointId: series.point.index,
    });
  }

  // Time window: 1d uses YYYY-MM-DD day strings; 5m/30m uses an epoch-ms dense timeline (the 30m
  // read's 25-min lead-in — a bucket needs six 5m readings — is applied inside fetchAggRowsPg).
  const startDate =
    interval === "1d" ? (startTime as CalendarDate).toString() : undefined;
  const endDate =
    interval === "1d" ? (endTime as CalendarDate).toString() : undefined;

  // Serve from Postgres: read the window and build the OpenNEM series via the shared transform.
  // (The Sankey no longer rides these rows — the attributed matrix is built independently from the
  // flow_attr_1d rollup + per-edge-day live computes; see the route's attr branch.)
  const rows = await fetchAggRowsPg({
    uniquePairs: uniquePairsArray,
    interval,
    firstEpoch,
    lastEpoch,
    startDate,
    endDate,
  });
  const series = await buildSeriesFromAggRows(
    rows,
    seriesInfos,
    interval,
    timezoneOffsetMin,
    firstEpoch,
    lastEpoch,
    debug,
  );

  return {
    series,
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
  attributedFlow?: DailyFlowMatrices | null,
  attributedFlowOmittedReason?: string,
  timer?: ServerTimer,
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

  // The ATTRIBUTED matrix (energy + emissions/renewable/cost legs) behind the Sankey and its node
  // tooltips — flow_attr_1d rollup days + live-computed partial edge days for sub-daily windows,
  // pure rollup for 1d (see lib/history/attributed-window.ts). Never blocks the request on failure
  // (P3); the reason explains a blank payload. The old energy-only `flowMatrix` projection is
  // retired — the attributed matrix's energy leg IS that matrix (computeFlowMatrix is
  // computeFlowAccounting's energy projection), and its degraded form carries null metric legs.
  if (attributedFlow) {
    response.attributedFlow = attributedFlow;
  } else if (attributedFlowOmittedReason) {
    response.attributedFlowOmittedReason = attributedFlowOmittedReason;
  }

  const jsonStr = timer
    ? timer.timeSync("serialize", () => formatOpenNEMResponse(response))
    : formatOpenNEMResponse(response);

  return new NextResponse(jsonStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...serverTimingHeaders(timer),
    },
  });
}

// ============================================================================
// Main Handler
// ============================================================================

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const t = makeTimer(request);
  try {
    // Parse basic parameters (interval, debug)
    const searchParams = request.nextUrl.searchParams;

    // Metadata-only listing mode (`?list=series`): what series exist, no data arrays, no time
    // range. Interval is not required — the per-entry `intervals` field answers that question
    // better than a filter would (an interval filter silently hides the 1d-only soc stats).
    // The subject resolution and authorization below are SHARED with the data path; the branch
    // itself sits after `requireDashboardAccess`, so this mode can never relax auth.
    const listParam = searchParams.get("list");
    if (listParam !== null && listParam !== "series") {
      return NextResponse.json(
        { error: `Unsupported list mode: '${listParam}'. Only 'series'.` },
        { status: 400 },
      );
    }
    const listSeries = listParam === "series";

    const basicParams = parseBasicParams(searchParams);
    if (!listSeries && !basicParams.isValid) {
      return NextResponse.json(
        { error: basicParams.error },
        { status: basicParams.statusCode! },
      );
    }

    // Resolve the subject: `?areaId=ar_…` / `?deviceId=dv_…` / the permanent `?systemId=N` alias
    // (device-first — trap D-l; see lib/dashboard/subject.ts). Everything below is handle-keyed: the
    // series layer, `resolveLogicalSystem` and the attributed-flow builder all still take the integer.
    const address = await resolveWireAddress(searchParams);
    if (!address.ok) {
      return NextResponse.json(
        { error: address.error },
        { status: address.status },
      );
    }
    const handle = address.handle;

    // Authenticate and check access (owner/admin/viewer/public, or a valid dashboard share token).
    // `auth` spans the whole access check; the threaded timer adds its inner `clerk`/`admin` splits.
    const authResult = await t.time("auth", () =>
      // `address.prefer` is threaded into the authorization — see the note in `/api/data`'s route and
      // `requireDashboardAccess`: for a colliding handle the area is the wider scope, so the entity the
      // caller named is the entity that gets checked.
      requireDashboardAccess(request, handle, t, address.prefer),
    );
    if (authResult instanceof NextResponse) return authResult;
    // `subject` is the area-native identity — the ONLY identity this route now carries. Phase 13 PR 2
    // removed the legacy device-shaped `system` view: the series layer takes the bare handle and the
    // timezone comes off the subject, so there is no longer a second, device-first identity to disagree
    // with it.
    const { subject } = authResult;
    const tzOffsetMin = subjectTimezoneOffsetMin(subject);

    if (listSeries) {
      // A present-but-invalid interval is refused (not ignored): a misspelling must not
      // silently change nothing. A VALID interval is tolerated and unused.
      const iv = searchParams.get("interval");
      if (iv !== null && !["5m", "30m", "1d"].includes(iv)) {
        return NextResponse.json(
          { error: "Only 5m, 30m, and 1d intervals are supported" },
          { status: 400 },
        );
      }
      const seriesParam = searchParams.get("series");
      const patterns = seriesParam ? splitBraceAware(seriesParam) : [];
      if (patterns.length > 0) {
        const v = validateSeriesPatterns(patterns);
        if (!v.valid) {
          return NextResponse.json({ error: v.error }, { status: 400 });
        }
      }
      const listing = await t.time("list", () =>
        buildSeriesListing(handle, tzOffsetMin, patterns),
      );
      return NextResponse.json(
        {
          ...listing,
          subject: {
            handle,
            displayTimezone: subjectDisplayTimezone(subject),
            timezoneOffsetMin: tzOffsetMin,
          },
        },
        { headers: serverTimingHeaders(t) },
      );
    }

    // Parse time range
    const timeRange = parseTimeRangeParams(
      searchParams,
      basicParams.interval as "5m" | "30m" | "1d",
      tzOffsetMin,
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

    // Optional attributed energy-flow Sankey bundled with the history payload (?include=sankey).
    const includeParam = searchParams.get("include");
    const includeSankey = includeParam
      ? includeParam
          .split(",")
          .map((s) => s.trim())
          .includes("sankey")
      : false;
    // One logical-system resolve per request, shared by every interval's attr branch (it used to be
    // resolved twice on some paths), and TTL-memoised across requests — it is near-static config,
    // and week-by-week navigation re-resolves it on every request.
    let logicalSystem: LogicalSystem | null = null;
    if (includeSankey) {
      logicalSystem = await t.time("logical", () =>
        cachedLogicalSystem(handle),
      );
    }
    // 🛑 Completeness gates the LIVE sub-daily compute only. The 1d reader is deliberately handed
    // the system whether or not it is complete: an area whose current bindings have gone incomplete
    // can still have materialised `flow_attr_1d` history, and `readAttributedDailyMatrices` serves
    // those rows, consulting `isComplete` only to EXPLAIN an empty result. Gating it here blanked
    // every M/Y Sankey for such an area.
    const completeLogicalSystem =
      logicalSystem && logicalSystem.isComplete ? logicalSystem : null;

    // The series fetch and the attributed matrix are independent (the attr side reads the
    // flow_attr_1d rollup + its own agg_5m windows), so they run CONCURRENTLY — the smaller span
    // leaves the request's critical path entirely.
    const fetchPromise = t.time("fetch", () =>
      getDeviceHistoryInOpenNEMFormat(
        handle,
        tzOffsetMin,
        timeRange.startTime!,
        timeRange.endTime!,
        interval,
        seriesPatterns.length > 0 ? seriesPatterns : undefined,
        basicParams.enableDebug,
      ),
    );

    // The ATTRIBUTED matrix (energy + emissions/renewable/cost/estimated legs) behind the Sankey and
    // its node tooltips. Sub-daily: flow_attr_1d rollup days + live-computed partial edge days
    // (lib/history/attributed-window.ts); 1d: the pure rollup read. Wrapped so a failure degrades to
    // no matrix + a reason rather than failing the whole history request (P3) — and the sub-daily
    // builder itself degrades per segment to an energy-only matrix (null metric legs) first.
    let attributedFlow: DailyFlowMatrices | undefined;
    let attributedFlowOmittedReason: string | undefined;
    const attrPromise = includeSankey
      ? t.time("attr", async () => {
          if (interval === "1d") {
            if (!planetscaleDb) {
              attributedFlowOmittedReason = "database-unavailable";
              return;
            }
            try {
              const startYMD = (timeRange.startTime as CalendarDate).toString();
              const endYMD = (timeRange.endTime as CalendarDate).toString();
              // `logicalSystem`, NOT `completeLogicalSystem` — see the note at its declaration.
              const attr = await readAttributedDailyMatrices(
                planetscaleDb,
                logicalSystem,
                startYMD,
                endYMD,
              );
              if (attr.days.length > 0) {
                attributedFlow = attr;
              } else {
                attributedFlowOmittedReason = attr.reason ?? "not-materialized";
              }
            } catch (error) {
              console.error("[history] attributed flow (1d) failed:", error);
              attributedFlowOmittedReason = "attributed-compute-failed";
            }
          } else {
            if (!completeLogicalSystem) {
              attributedFlowOmittedReason = "not-a-logical-system";
              return;
            }
            try {
              const startMs = (timeRange.startTime as ZonedDateTime)
                .toDate()
                .getTime();
              const endMs = (timeRange.endTime as ZonedDateTime)
                .toDate()
                .getTime();
              const attr = await buildAttributedFlowWindow(
                handle,
                startMs,
                endMs,
                completeLogicalSystem,
              );
              if (attr) {
                attributedFlow = attr;
              } else {
                attributedFlowOmittedReason = "no-provenance-inputs";
              }
            } catch (error) {
              console.error("[history] attributed flow failed:", error);
              attributedFlowOmittedReason = "attributed-compute-failed";
            }
          }
        })
      : Promise.resolve();

    const [{ series: dataSeries, dataSource, debug, sqlQueries }] =
      await Promise.all([fetchPromise, attrPromise]);

    // Build and return response
    const durationMs = Date.now() - startTime;
    return buildResponse(
      dataSeries,
      timeRange.startTime!,
      timeRange.endTime!,
      interval,
      durationMs,
      subjectDisplayTimezone(subject),
      dataSource,
      debug,
      seriesPatterns.length > 0 ? seriesPatterns : undefined,
      sqlQueries,
      attributedFlow,
      attributedFlowOmittedReason,
      t,
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
