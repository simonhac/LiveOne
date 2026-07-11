import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { getPollingStatus } from "@/lib/polling-utils";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";
import { SystemsManager } from "@/lib/systems-manager";
import { PointManager } from "@/lib/point/point-manager";
import { resolvePointDisplay } from "@/lib/point/display/registry";
import { clerkClient } from "@clerk/nextjs/server";

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

export async function GET(request: NextRequest) {
  try {
    // Get systemId from query parameters
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

    const systemId = parseInt(systemIdParam);
    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Authenticate and check access (owner/admin/viewer/public, or a valid dashboard share token).
    const authResult = await requireDashboardAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;
    const { system, userId } = authResult;

    // Get polling status from Postgres
    const pollingStatusResult = await getPollingStatus(system.id);

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

    // Get latest point values from KV cache (composite points system)
    const latest = await getLatestPointValues(system.id);

    // `include=readings` → also build the detailed readings table (the former
    // /api/system/{id}/latest route): every active point merged with its cached value, including
    // expected-but-missing points + session labels. Computed only on request so the hot dashboard
    // poll stays lean. This makes /api/data the single producer of the KV latest cache.
    const include = (searchParams.get("include") || "")
      .split(",")
      .map((s) => s.trim());
    let readings: LatestReadingRow[] | undefined;
    if (include.includes("readings")) {
      const expectedPoints =
        await PointManager.getInstance().getActivePointsForSystem(system.id);
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

    // The logged-in user's system-switcher list. A public share-token viewer (no userId) gets none.
    const systemsManager = SystemsManager.getInstance();
    const availableSystems = userId
      ? await systemsManager.getSystemsVisibleByUser(userId, true) // active only
      : [];
    let currentUsername: string | null = null;
    if (userId) {
      const clerk = await clerkClient();
      currentUsername = (await clerk.users.getUser(userId)).username || null;
    }
    const systemsWithUsernames = availableSystems.map((sys) => ({
      ...sys,
      ownerUsername: sys.ownerClerkUserId === userId ? currentUsername : null,
    }));

    // Return with automatic date formatting and field renaming
    // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime)
    return jsonResponse(
      {
        system: systemData,
        latest: latest,
        availableSystems: systemsWithUsernames,
        ...(readings !== undefined && { readings }),
      },
      system.timezoneOffsetMin,
    );
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
