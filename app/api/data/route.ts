import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SELECTLIVE_CONFIG } from "@/config";
import { db } from "@/lib/db";
import {
  systems,
  readings,
  pollingStatus,
  readingsAgg1d,
  userSystems,
} from "@/lib/db/schema";
import { eq, and, desc, or } from "drizzle-orm";
import {
  formatTimeAEST,
  formatTime_fromJSDate,
  getYesterdayDate,
  fromUnixTimestamp,
} from "@/lib/date-utils";
import { roundToThree } from "@/lib/history/format-opennem";
import { isUserAdmin } from "@/lib/auth-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";

// Helper function to ensure values are null instead of undefined
function nullifyUndefined<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export async function GET(request: Request) {
  try {
    // Get the authenticated user's Clerk ID
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        { status: 401 },
      );
    }

    // Get systemId from query parameters
    const { searchParams } = new URL(request.url);
    const systemId = searchParams.get("systemId");

    if (!systemId) {
      return NextResponse.json(
        {
          error: "System ID is required",
        },
        { status: 400 },
      );
    }

    // Get the system first
    const [system] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, parseInt(systemId)))
      .limit(1);

    if (!system) {
      return NextResponse.json(
        {
          error: "System not found",
        },
        { status: 404 },
      );
    }

    // Check if user has access to this system
    // Admin can access all systems, regular users can only access their own
    const isAdmin = await isUserAdmin();

    // Check user access via userSystems table (for non-owners who have been granted access)
    const userSystemAccess = await db
      .select()
      .from(userSystems)
      .where(
        and(
          eq(userSystems.clerkUserId, userId),
          eq(userSystems.systemId, system.id),
        ),
      )
      .limit(1);

    const hasDirectAccess = userSystemAccess.length > 0;
    const isOwner = system.ownerClerkUserId === userId;

    if (!isAdmin && !isOwner && !hasDirectAccess) {
      return NextResponse.json(
        {
          error: "Access denied to system",
        },
        { status: 403 },
      );
    }

    // Determine user role
    const userRole = isAdmin
      ? "admin"
      : isOwner
        ? "owner"
        : hasDirectAccess
          ? userSystemAccess[0].role
          : "viewer";

    // Get polling status from database
    const [status] = await db
      .select()
      .from(pollingStatus)
      .where(eq(pollingStatus.systemId, system.id))
      .limit(1);

    // Get yesterday's aggregated data using system's timezone
    const systemTimezoneOffsetMinutes = system.timezoneOffsetMin;
    const yesterdayDate = getYesterdayDate(systemTimezoneOffsetMinutes);
    const [yesterdayData] = await db
      .select()
      .from(readingsAgg1d)
      .where(
        and(
          eq(readingsAgg1d.systemId, String(system.id)),
          eq(readingsAgg1d.day, yesterdayDate),
        ),
      )
      .limit(1);

    // Build the common metadata structure
    const metadata = {
      vendorType: system.vendorType,
      vendorSiteId: system.vendorSiteId,
      displayName: system.displayName,
      ownerClerkUserId: system.ownerClerkUserId,
      supportsPolling: VendorRegistry.supportsPolling(system.vendorType),
      timezoneOffsetMin: system.timezoneOffsetMin,
      systemInfo: {
        model: system.model,
        serial: system.serial,
        ratings: system.ratings,
        solarSize: system.solarSize,
        batterySize: system.batterySize,
      },
      polling: status
        ? {
            lastPollTime: status?.lastPollTime
              ? formatTime_fromJSDate(
                  status.lastPollTime,
                  system.timezoneOffsetMin,
                )
              : null,
            lastSuccessTime: status?.lastSuccessTime
              ? formatTime_fromJSDate(
                  status.lastSuccessTime,
                  system.timezoneOffsetMin,
                )
              : null,
            lastErrorTime: status?.lastErrorTime
              ? formatTime_fromJSDate(
                  status.lastErrorTime,
                  system.timezoneOffsetMin,
                )
              : null,
            lastError: status?.lastError || null,
            consecutiveErrors: status?.consecutiveErrors || 0,
            totalPolls: status?.totalPolls || 0,
            successfulPolls: status?.successfulPolls || 0,
            isActive: system.status === "active",
          }
        : null,
    };

    // Get latest point values from KV cache (composite points system)
    const latest = await getLatestPointValues(system.id);

    // Build historical section
    const historical = {
      yesterday: yesterdayData
        ? {
            date: yesterdayData.day,
            energy: {
              solarKwh: roundToThree(yesterdayData.solarKwh),
              loadKwh: roundToThree(yesterdayData.loadKwh),
              batteryChargeKwh: roundToThree(yesterdayData.batteryChargeKwh),
              batteryDischargeKwh: roundToThree(
                yesterdayData.batteryDischargeKwh,
              ),
              gridImportKwh: roundToThree(yesterdayData.gridImportKwh),
              gridExportKwh: roundToThree(yesterdayData.gridExportKwh),
            },
            power: {
              solar: {
                minW: nullifyUndefined(yesterdayData.solarWMin),
                avgW: nullifyUndefined(yesterdayData.solarWAvg),
                maxW: nullifyUndefined(yesterdayData.solarWMax),
              },
              load: {
                minW: nullifyUndefined(yesterdayData.loadWMin),
                avgW: nullifyUndefined(yesterdayData.loadWAvg),
                maxW: nullifyUndefined(yesterdayData.loadWMax),
              },
              battery: {
                minW: nullifyUndefined(yesterdayData.batteryWMin),
                avgW: nullifyUndefined(yesterdayData.batteryWAvg),
                maxW: nullifyUndefined(yesterdayData.batteryWMax),
              },
              grid: {
                minW: nullifyUndefined(yesterdayData.gridWMin),
                avgW: nullifyUndefined(yesterdayData.gridWAvg),
                maxW: nullifyUndefined(yesterdayData.gridWMax),
              },
            },
            soc: {
              minBattery: roundToThree(yesterdayData.batterySocMin),
              avgBattery: roundToThree(yesterdayData.batterySocAvg),
              maxBattery: roundToThree(yesterdayData.batterySocMax),
              endBattery: roundToThree(yesterdayData.batterySocEnd),
            },
            dataQuality: {
              intervalCount: nullifyUndefined(yesterdayData.intervalCount),
              coverage: yesterdayData.intervalCount
                ? `${Math.round((yesterdayData.intervalCount / 288) * 100)}%`
                : null,
            },
          }
        : null,
      // Placeholder for future periods
      // lastWeek: null,
      // lastMonth: null,
    };

    // Return with automatic date formatting and field renaming
    // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime)
    return jsonResponse(
      {
        latest: latest,
        historical: historical,
        ...metadata,
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
