import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { getPollingStatus } from "@/lib/polling-utils";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";
import { SystemsManager } from "@/lib/systems-manager";
import { clerkClient } from "@clerk/nextjs/server";

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
