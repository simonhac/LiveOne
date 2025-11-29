import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { getLatestValues, clearLatestValues } from "@/lib/latest-values-store";
import { PointManager } from "@/lib/point/point-manager";
import { SystemsManager } from "@/lib/systems-manager";
import { jsonResponse } from "@/lib/json";

/**
 * API response type - extends LatestValue with optional fields for points without cached data
 */
interface LatestValueResponse {
  value?: number | string | boolean;
  logicalPath: string | null;
  measurementTimeMs?: number;
  receivedTimeMs?: number;
  metricUnit: string;
  pointName: string;
  reference?: string; // Format: "systemId.pointId"
  sessionId?: number; // Session that wrote this value
  sessionLabel?: string; // Session label/name for display
}

/**
 * GET /api/system/{systemId}/latest
 *
 * Returns all latest values from the KV cache for a system.
 * Values are returned as an array sorted by displayName.
 *
 * Note: action=clear will empty the cache for this system
 *
 * @param systemId - Numeric system ID
 * @query action - Optional. If "clear", empties the cache and returns success message.
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

    // Check for action=clear query parameter
    const action = request.nextUrl.searchParams.get("action");
    if (action === "clear") {
      await clearLatestValues(systemId);
      return NextResponse.json({
        success: true,
        systemId,
        message: "Cache cleared for this system",
      });
    }

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
        // Convert numeric values to boolean when unit is "boolean"
        let displayValue: number | string | boolean | null = cached.value;
        if (
          cached.metricUnit === "boolean" &&
          typeof cached.value === "number"
        ) {
          displayValue = cached.value !== 0;
        }

        return {
          ...(displayValue != null && { value: displayValue }),
          logicalPath: cached.logicalPath,
          ...(cached.measurementTimeMs != null && {
            measurementTimeMs: cached.measurementTimeMs,
          }),
          ...(cached.receivedTimeMs != null && {
            receivedTimeMs: cached.receivedTimeMs,
          }),
          metricUnit: cached.metricUnit,
          pointName: cached.displayName,
          ...(cached.reference != null && { reference: cached.reference }),
          ...(cached.sessionId != null && { sessionId: cached.sessionId }),
          ...(cached.sessionLabel != null && {
            sessionLabel: cached.sessionLabel,
          }),
        };
      }

      // No cached value - only include non-null fields
      return {
        logicalPath: logicalPath,
        metricUnit: point.metricUnit,
        pointName: point.name,
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
