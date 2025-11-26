import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems, pollingStatus, userSystems } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { isUserAdmin } from "@/lib/auth-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";
import { SystemsManager } from "@/lib/systems-manager";
import { clerkClient } from "@clerk/nextjs/server";

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
      pollingStatus: status
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
