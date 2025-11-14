import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SystemIdentifier } from "@/lib/identifiers";
import { resolveSystemFromIdentifier } from "@/lib/series-path-utils";
import { isUserAdmin } from "@/lib/auth-utils";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { unixToFormattedAEST } from "@/lib/date-utils";

/**
 * GET /api/system/{systemIdentifier}/points/latest
 *
 * Returns the latest values for all points in a system from the KV cache
 *
 * @param systemIdentifier - System identifier (numeric ID like "3" or user.shortname like "simon.kinkora")
 *
 * Example:
 * GET /api/system/3/points/latest
 *
 * Returns:
 * {
 *   "systemId": 3,
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
 *   }
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

    // Step 5: Get latest values from KV cache
    const latestValues = await getLatestPointValues(systemId);

    // Step 6: Format timestamps to AEST
    const formattedPoints: Record<
      string,
      {
        value: number;
        measurementTime: string;
        receivedTime: string;
        metricUnit: string;
      }
    > = {};

    for (const [pointPath, pointValue] of Object.entries(latestValues)) {
      formattedPoints[pointPath] = {
        value: pointValue.value,
        measurementTime: unixToFormattedAEST(
          pointValue.measurementTimeMs,
          true,
        ),
        receivedTime: unixToFormattedAEST(pointValue.receivedTimeMs, true),
        metricUnit: pointValue.metricUnit,
      };
    }

    return NextResponse.json({
      systemId,
      points: formattedPoints,
    });
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
