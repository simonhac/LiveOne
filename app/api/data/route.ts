import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { getPollingStatus } from "@/lib/polling-utils";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { jsonResponse, transformDates } from "@/lib/json";
import { PointManager } from "@/lib/point/point-manager";
import { resolvePointDisplay } from "@/lib/point/display/registry";
import type { SystemWithPolling } from "@/lib/systems-manager";

/**
 * One row of the detailed "latest readings" table (`include=readings`). A superset of the `latest`
 * map: it also lists active points that have NO cached value yet (expected-but-missing) and carries
 * per-point metadata (physical path, session labels). Date fields are renamed by `jsonResponse`
 * (measurementTimeMs → measurementTime).
 */
interface LatestReadingRow {
  value?: number | string | boolean;
  physicalPath: string;
  logicalPath: string | null;
  pointReference?: string;
  measurementTimeMs?: number;
  receivedTimeMs?: number;
  metricUnit: string;
  pointName: string;
  sessionId?: string;
  sessionLabel?: string;
  /** Resolved from the central display registry (unit + Excel number format), null when uncovered. */
  displayUnit?: string;
  displayFormat?: string;
}

/** The raw (untransformed) payload for one system — shared by the single-system and batch paths. */
async function buildSystemPayload(
  system: SystemWithPolling,
  wantsReadings: boolean,
) {
  // Polling status, the KV latest-values cache, and (if requested) the active-points list are
  // mutually independent reads — fire them concurrently rather than paying each round-trip in
  // sequence.
  const [pollingStatusResult, latest, expectedPoints] = await Promise.all([
    getPollingStatus(system.id),
    getLatestPointValues(system.id),
    wantsReadings
      ? PointManager.getInstance().getActivePointsForSystem(system.id)
      : Promise.resolve(undefined),
  ]);

  // Build the system object with full SystemWithPolling data
  const systemData = {
    id: system.id,
    vendorType: system.vendorType,
    vendorSiteId: system.vendorSiteId,
    displayName: system.displayName,
    alias: system.alias,
    displayTimezone: system.displayTimezone,
    ownerClerkUserId: system.ownerClerkUserId,
    timezoneOffsetMin: system.timezoneOffsetMin,
    status: system.status,
    model: system.model,
    serial: system.serial,
    ratings: system.ratings,
    solarSize: system.solarSize,
    batterySize: system.batterySize,
    location: system.location,
    metadata: system.metadata,
    config: system.config,
    createdAt: system.createdAt,
    updatedAt: system.updatedAt,
    supportsPolling: VendorRegistry.supportsPolling(system.vendorType),
    pollingStatus: pollingStatusResult
      ? {
          lastPollTime: pollingStatusResult?.lastPollTime
            ? formatTime_fromJSDate(
                pollingStatusResult.lastPollTime,
                system.timezoneOffsetMin,
              )
            : null,
          lastSuccessTime: pollingStatusResult?.lastSuccessTime
            ? formatTime_fromJSDate(
                pollingStatusResult.lastSuccessTime,
                system.timezoneOffsetMin,
              )
            : null,
          lastErrorTime: pollingStatusResult?.lastErrorTime
            ? formatTime_fromJSDate(
                pollingStatusResult.lastErrorTime,
                system.timezoneOffsetMin,
              )
            : null,
          lastError: pollingStatusResult?.lastError || null,
          consecutiveErrors: pollingStatusResult?.consecutiveErrors || 0,
          totalPolls: pollingStatusResult?.totalPolls || 0,
          successfulPolls: pollingStatusResult?.successfulPolls || 0,
          isActive: system.status === "active",
        }
      : null,
  };

  let readings: LatestReadingRow[] | undefined;
  if (expectedPoints) {
    readings = expectedPoints
      .map((point): LatestReadingRow => {
        const logicalPath = point.getLogicalPath();
        const display = resolvePointDisplay(
          system.vendorType,
          point.subsystem,
          point.physicalPathTail,
        );
        const displayFields = display
          ? { displayUnit: display.unit, displayFormat: display.format }
          : {};
        const cached = logicalPath ? latest[logicalPath] : null;
        if (cached) {
          // Numeric → boolean when the unit says so (the readings table renders true/false).
          let displayValue: number | string | boolean | null = cached.value;
          if (
            cached.metricUnit === "boolean" &&
            typeof cached.value === "number"
          ) {
            displayValue = cached.value !== 0;
          }
          return {
            ...(displayValue != null && { value: displayValue }),
            physicalPath: point.physicalPathTail,
            logicalPath: cached.logicalPath,
            ...(cached.pointReference != null && {
              pointReference: cached.pointReference,
            }),
            ...(cached.measurementTimeMs != null && {
              measurementTimeMs: cached.measurementTimeMs,
            }),
            ...(cached.receivedTimeMs != null && {
              receivedTimeMs: cached.receivedTimeMs,
            }),
            metricUnit: cached.metricUnit,
            pointName: cached.displayName,
            ...(cached.sessionId != null && { sessionId: cached.sessionId }),
            ...(cached.sessionLabel != null && {
              sessionLabel: cached.sessionLabel,
            }),
            ...displayFields,
          };
        }
        // No cached value — expected-but-missing point.
        return {
          physicalPath: point.physicalPathTail,
          logicalPath,
          metricUnit: point.metricUnit,
          pointName: point.name,
          ...displayFields,
        };
      })
      .sort(
        (a, b) =>
          (a.pointName || "").localeCompare(b.pointName || "") ||
          (a.logicalPath || "").localeCompare(b.logicalPath || ""),
      );
  }

  return {
    system: systemData,
    latest,
    ...(readings !== undefined && { readings }),
  };
}

export async function GET(request: NextRequest) {
  try {
    // Get systemId(s) from query parameters. A comma-separated list is a BATCH request (used only by
    // the dashboard's own prefetch, `dashboardDataBatchQuery` — see lib/queries/data.ts): one request
    // instead of N, response shaped `{data: {[systemId]: <the single-system payload below>}}`. Any id
    // that fails auth is silently OMITTED from `data` (not a whole-request failure) — a batch mixes
    // systems with different access, same as fetching them individually would. A lone id keeps the
    // original flat single-system shape, byte-identical to before batching existed.
    const { searchParams } = new URL(request.url);
    const systemIdParam = searchParams.get("systemId");

    if (!systemIdParam) {
      return NextResponse.json(
        {
          error: "System ID is required",
        },
        { status: 400 },
      );
    }

    const systemIds = systemIdParam
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n, i, arr) => arr.indexOf(n) === i);
    if (systemIds.length === 0 || systemIds.some((n) => isNaN(n))) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const include = (searchParams.get("include") || "")
      .split(",")
      .map((s) => s.trim());
    // `include=readings` → also build the detailed readings table (the former
    // /api/system/{id}/latest route): every active point merged with its cached value, including
    // expected-but-missing points + session labels. Computed only on request so the hot dashboard
    // poll stays lean. This makes /api/data the single producer of the KV latest cache.
    const wantsReadings = include.includes("readings");

    if (systemIds.length === 1) {
      // Authenticate and check access (owner/admin/viewer/public, or a valid dashboard share token).
      const authResult = await requireDashboardAccess(request, systemIds[0]);
      if (authResult instanceof NextResponse) return authResult;
      const payload = await buildSystemPayload(
        authResult.system,
        wantsReadings,
      );
      // Return with automatic date formatting and field renaming
      // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime)
      return jsonResponse(payload, authResult.system.timezoneOffsetMin);
    }

    // Batch: auth + build each system concurrently; a per-id auth failure just omits that id.
    const results = await Promise.all(
      systemIds.map(async (id) => {
        const authResult = await requireDashboardAccess(request, id);
        if (authResult instanceof NextResponse) return null;
        const payload = await buildSystemPayload(
          authResult.system,
          wantsReadings,
        );
        return [
          id,
          transformDates(payload, authResult.system.timezoneOffsetMin),
        ] as const;
      }),
    );
    const data = Object.fromEntries(
      results.filter((r): r is readonly [number, unknown] => r !== null),
    );
    return NextResponse.json({ data });
  } catch (error) {
    console.error("API Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        timestamp: new Date(),
      },
      { status: 500 },
    );
  }
}
