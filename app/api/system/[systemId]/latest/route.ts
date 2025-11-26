import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
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
    // Parse and validate systemId
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);

    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    // Authenticate and authorize
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    // Get latest values from KV cache
    const latestValuesMap = await getLatestValues(systemId);

    // Convert to array and sort by displayName, then logicalPath
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
