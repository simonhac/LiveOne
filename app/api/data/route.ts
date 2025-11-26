import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { pollingStatus } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

    // Authenticate and check system access
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;
    const { system, userId } = authResult;

    // Get polling status from database
    const [pollingStatusResult] = await db
      .select()
      .from(pollingStatus)
      .where(eq(pollingStatus.systemId, system.id))
      .limit(1);

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

    // Fetch available systems for the user
    const systemsManager = SystemsManager.getInstance();
    const availableSystems = await systemsManager.getSystemsVisibleByUser(
      userId,
      true, // active only
    );

    // Get current user's username for their own systems
    const clerk = await clerkClient();
    const currentUser = await clerk.users.getUser(userId);
    const currentUsername = currentUser.username || null;

    // Add username to systems owned by current user
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
