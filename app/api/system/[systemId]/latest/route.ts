import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resolveSystemFromIdentifier } from "@/lib/series-path-utils";
import { isUserAdmin } from "@/lib/auth-utils";
import { getLatestValues, LatestValue } from "@/lib/latest-values-store";

/**
 * GET /api/system/{systemId}/latest
 *
 * Returns all latest values from the KV cache for a system.
 * Values are returned as an array sorted by displayName.
 *
 * @param systemId - Numeric system ID
 *
 * Example response:
 * {
 *   "systemId": 1586,
 *   "count": 12,
 *   "values": [
 *     {
 *       "value": 5234.5,
 *       "logicalPath": "source.solar.local/power",
 *       "measurementTimeMs": 1700000000000,
 *       "metricUnit": "W",
 *       "displayName": "Solar Power"
 *     },
 *     ...
 *   ]
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    // Step 1: Authenticate
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
      isAdmin = await isUserAdmin(userId);
    }

    // Step 2: Parse systemId
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);

    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    // Step 3: Resolve system and check it exists
    const system = await resolveSystemFromIdentifier(systemIdStr);

    if (!system) {
      return NextResponse.json(
        { error: `System not found: ${systemId}` },
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
    const latestValuesMap = await getLatestValues(systemId);

    // Step 6: Convert to array and sort by displayName, then logicalPath
    const values: LatestValue[] = Object.values(latestValuesMap).sort(
      (a, b) =>
        (a.displayName || "").localeCompare(b.displayName || "") ||
        (a.logicalPath || "").localeCompare(b.logicalPath || ""),
    );

    return NextResponse.json({
      systemId,
      count: values.length,
      values,
    });
  } catch (error) {
    console.error("Error fetching latest values:", error);
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
