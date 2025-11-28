import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { getLatestValues } from "@/lib/latest-values-store";
import { PointManager } from "@/lib/point/point-manager";
import { SystemsManager } from "@/lib/systems-manager";
import { jsonResponse } from "@/lib/json";

/**
 * API response type - extends LatestValue with nullable fields for points without cached data
 */
interface LatestValueResponse {
  value: number | string | null;
  logicalPath: string | null;
  measurementTimeMs: number | null;
  receivedTimeMs: number | null;
  metricUnit: string;
  pointName: string;
  reference: string | null; // Format: "systemId.pointId"
}

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

    // 1. Get system for timezone
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);
    const timezoneOffsetMin = system?.timezoneOffsetMin ?? 600; // Default to AEST

    // 2. Get all active points for this system (via PointManager)
    const pointManager = PointManager.getInstance();
    const expectedPoints =
      await pointManager.getActivePointsForSystem(systemId);

    // 3. Get latest values from KV cache
    const latestValuesMap = await getLatestValues(systemId);

    // 4. Merge: use KV values where available, fall back to point info for missing
    const values: LatestValueResponse[] = expectedPoints.map((point) => {
      const logicalPath = point.getLogicalPath();
      const cached = logicalPath ? latestValuesMap[logicalPath] : null;

      if (cached) {
        return {
          value: cached.value,
          logicalPath: cached.logicalPath,
          measurementTimeMs: cached.measurementTimeMs,
          receivedTimeMs: cached.receivedTimeMs,
          metricUnit: cached.metricUnit,
          pointName: cached.displayName,
          reference: cached.reference ?? null,
        };
      }

      // No cached value - no source info available
      return {
        value: null,
        logicalPath: logicalPath,
        measurementTimeMs: null,
        receivedTimeMs: null,
        metricUnit: point.metricUnit,
        pointName: point.name,
        reference: null,
      };
    });

    // Sort by pointName, then logicalPath
    values.sort(
      (a, b) =>
        (a.pointName || "").localeCompare(b.pointName || "") ||
        (a.logicalPath || "").localeCompare(b.logicalPath || ""),
    );

    return jsonResponse(
      {
        systemId,
        count: values.length,
        values,
      },
      timezoneOffsetMin,
    );
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
