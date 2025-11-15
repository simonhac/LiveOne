import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SystemIdentifier } from "@/lib/identifiers";
import { resolveSystemFromIdentifier } from "@/lib/series-path-utils";
import { isUserAdmin } from "@/lib/auth-utils";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { kv, kvKey } from "@/lib/kv";
import { jsonResponse } from "@/lib/json";
import { getEnvironment } from "@/lib/env";

/**
 * GET /api/system/{systemIdentifier}/points/latest
 *
 * Returns the latest values for all points in a system from the KV cache
 *
 * Query Parameters:
 * - action=clear: Clear the latest values cache for this system (admin only)
 * - action=clear-all: Clear all latest value caches for all systems (admin only)
 *
 * @param systemIdentifier - System identifier (numeric ID like "3" or user.shortname like "simon.kinkora")
 *
 * Example:
 * GET /api/system/3/points/latest
 * GET /api/system/3/points/latest?action=clear
 * GET /api/system/3/points/latest?action=clear-all
 *
 * Returns:
 * {
 *   "systemId": 3,
 *   "namespace": "dev",
 *   "count": 2,
 *   "points": {
 *     "source.solar.local/power": {
 *       "value": 5234.5,
 *       "measurementTime": "2025-11-14T23:45:00+10:00",
 *       "receivedTime": "2025-11-14T23:45:05+10:00",
 *       "metricUnit": "W"
 *     },
 *     "load.hvac/power": {
 *       "value": 1200,
 *       "measurementTime": "2025-11-14T23:45:00+10:00",
 *       "receivedTime": "2025-11-14T23:45:05+10:00",
 *       "metricUnit": "W"
 *     }
 *   },
 *   "note": "Use ?action=clear to clear cache for this system, or ?action=clear-all to clear all systems (admin only)"
 * }
 *
 * With action=clear:
 * {
 *   "systemId": 3,
 *   "message": "Cache cleared successfully",
 *   "action": "clear",
 *   "namespace": "dev"
 * }
 *
 * With action=clear-all:
 * {
 *   "message": "All latest value caches cleared successfully",
 *   "action": "clear-all",
 *   "namespace": "dev",
 *   "keysCleared": 5
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemIdentifier: string }> },
) {
  try {
    // Step 1: Authenticate
    // In development, allow using X-CLAUDE header to bypass auth
    let userId: string;
    let isAdmin = false;

    if (
      process.env.NODE_ENV === "development" &&
      request.headers.get("x-claude") === "true"
    ) {
      userId = "claude-dev";
      isAdmin = true;
    } else {
      const authResult = await auth();
      if (!authResult.userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = authResult.userId;
      // Check if user is admin using proper auth utils
      isAdmin = await isUserAdmin(userId);
    }

    // Step 2: Parse and validate systemIdentifier
    const { systemIdentifier: systemIdStr } = await params;

    // Parse system identifier
    const systemIdentifier = SystemIdentifier.parse(systemIdStr);

    if (!systemIdentifier) {
      return NextResponse.json(
        {
          error: "Invalid system identifier",
          details: `System identifier must be a numeric ID or user.shortname format, got "${systemIdStr}"`,
        },
        { status: 400 },
      );
    }

    // For now, only support numeric IDs (user.shortname requires additional lookup logic)
    if (systemIdentifier.type !== "id") {
      return NextResponse.json(
        {
          error: "User-scoped identifiers not yet supported",
          details: "Please use numeric system ID",
        },
        { status: 400 },
      );
    }

    const systemId = systemIdentifier.id!; // Safe because we checked type === "id"

    // Step 3: Resolve systemId to system and check it exists
    const system = await resolveSystemFromIdentifier(systemId.toString());

    if (!system) {
      return NextResponse.json(
        { error: `System not found: ${systemIdStr}` },
        { status: 404 },
      );
    }

    // Step 4: Check authorization
    if (!isAdmin && system.ownerClerkUserId !== userId) {
      return NextResponse.json(
        { error: "Forbidden: You do not have access to this system" },
        { status: 403 },
      );
    }

    // Step 5: Check for action parameter
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get("action");

    if (action === "clear") {
      // Only admins can clear cache
      if (!isAdmin) {
        return NextResponse.json(
          { error: "Admin access required to clear cache" },
          { status: 403 },
        );
      }

      // Clear the cache for this system
      const cacheKey = kvKey(`latest:system:${systemId}`);
      await kv.del(cacheKey);

      return NextResponse.json({
        systemId,
        message: "Cache cleared successfully",
        action: "clear",
        namespace: getEnvironment(),
      });
    }

    if (action === "clear-all") {
      // Only admins can clear cache
      if (!isAdmin) {
        return NextResponse.json(
          { error: "Admin access required to clear cache" },
          { status: 403 },
        );
      }

      // Clear all latest value entries across all systems
      const pattern = kvKey("latest:system:*");
      const keys = await kv.keys(pattern);

      // Delete all keys
      for (const key of keys) {
        await kv.del(key);
      }

      return NextResponse.json({
        message: "All latest value caches cleared successfully",
        action: "clear-all",
        namespace: getEnvironment(),
        keysCleared: keys.length,
      });
    }

    // Step 6: Get latest values from KV cache
    const latestValues = await getLatestPointValues(systemId);

    // Count the number of points
    const pointCount = Object.keys(latestValues).length;

    // Return with automatic date formatting and field renaming
    // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime)
    return jsonResponse(
      {
        systemId,
        namespace: getEnvironment(),
        count: pointCount,
        points: latestValues,
        note: "Use ?action=clear to clear cache for this system, or ?action=clear-all to clear all systems (admin only)",
      },
      system.timezoneOffsetMin,
    );
  } catch (error) {
    console.error("Error fetching latest point values:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 },
    );
  }
}
