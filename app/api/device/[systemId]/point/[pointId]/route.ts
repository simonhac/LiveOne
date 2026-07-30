import { NextRequest, NextResponse } from "next/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices, points } from "@/lib/db/planetscale/schema";
import { eq, and } from "drizzle-orm";
import { requireDeviceAccess } from "@/lib/api-auth";
import { isValidLogicalPathStem } from "@/lib/identifiers/logical-path";
import { PointManager } from "@/lib/point/point-manager";

/**
 * One point of `{systemId}`, by the `pointId` URL segment, from `points ⋈ devices` (slice 1b).
 *
 * `pointId` is a **`points.rid`** — a global integer, not the old per-device `point_info.index`. This
 * route is the pair to `PointManager.updatePoint`, whose WHERE moved to `rid` in the seam commit, so
 * reading on anything else here would 404 (or, worse, address a different point) for the 117-of-134
 * rows on dev where the two integers differ.
 */
function pointByRid(systemId: number, pointRid: number) {
  return requirePlanetscaleDb()
    .select({
      systemId: devices.rid,
      index: points.rid,
      physicalPathTail: points.physicalPath,
      logicalPathStem: points.logicalPath,
      metricType: points.metricType,
      metricUnit: points.unit,
      defaultName: points.defaultName,
      displayName: points.name,
      subsystem: points.subsystem,
      transform: points.transform,
      active: points.active,
    })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(and(eq(devices.rid, systemId), eq(points.rid, pointRid)))
    .limit(1);
}

/**
 * PATCH /api/device/{systemId}/point/{pointId}
 *
 * Updates user-modifiable fields on a point_info record.
 *
 * Updatable fields:
 * - displayName: string | null (user-friendly name)
 * - logicalPathStem: string | null (e.g., "source.solar", segments separated by ".")
 * - active: boolean (whether point is enabled)
 * - transform: string | null (null, 'i' for invert, 'd' for differentiate)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string; pointId: string }> },
) {
  try {
    const { systemId: systemIdStr, pointId: pointIdStr } = await params;

    const systemId = parseInt(systemIdStr, 10);
    const pointId = parseInt(pointIdStr, 10);

    if (isNaN(systemId) || isNaN(pointId)) {
      return NextResponse.json(
        { error: "Invalid systemId or pointId" },
        { status: 400 },
      );
    }

    // Authenticate and authorize
    const authResult = await requireDeviceAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;
    const { device } = authResult;

    // Parse request body
    const body = await request.json();

    // Validate the point exists
    const [existingPoint] = await pointByRid(systemId, pointId);

    if (!existingPoint) {
      return NextResponse.json(
        { error: `Point ${systemId}.${pointId} not found` },
        { status: 404 },
      );
    }

    // Build update object with only allowed fields
    const updateData: Record<string, any> = {};

    if (body.displayName !== undefined) {
      updateData.displayName = body.displayName;
    }
    if (body.logicalPathStem !== undefined) {
      // Validate logical path stem format if provided
      if (body.logicalPathStem !== null && body.logicalPathStem !== "") {
        if (!isValidLogicalPathStem(body.logicalPathStem)) {
          return NextResponse.json(
            {
              error:
                "Invalid logicalPathStem format. Use segments separated by dots (e.g., source.solar).",
            },
            { status: 400 },
          );
        }
      }
      updateData.logicalPathStem = body.logicalPathStem || null;
    }
    if (body.active !== undefined) {
      updateData.active = Boolean(body.active);
    }
    if (body.transform !== undefined) {
      // Validate transform values
      if (
        body.transform !== null &&
        body.transform !== "i" &&
        body.transform !== "d"
      ) {
        return NextResponse.json(
          { error: "Invalid transform. Must be null, 'i', or 'd'." },
          { status: 400 },
        );
      }
      updateData.transform = body.transform;
    }

    // Check if there's anything to update
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 },
      );
    }

    // Perform the update.
    // Routed through PointManager.updatePoint so the write honours
    // CONFIG_WRITES_TO_PG and the series cache is invalidated for this device.
    const pointManager = PointManager.getInstance();
    await pointManager.updatePoint(systemId, pointId, updateData);

    // Fetch the updated record
    const [updatedPoint] = await pointByRid(systemId, pointId);

    console.log(
      `[Point] Updated point ${systemId}.${pointId}:`,
      JSON.stringify(updateData),
    );

    // Construct full physical path: liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}
    const fullPhysicalPath = `liveone/${device.vendorType}/${device.vendorSiteId}/${updatedPoint.physicalPathTail}`;

    return NextResponse.json({
      success: true,
      point: {
        systemId: updatedPoint.systemId,
        pointId: updatedPoint.index,
        physicalPath: fullPhysicalPath,
        logicalPathStem: updatedPoint.logicalPathStem,
        displayName: updatedPoint.displayName,
        active: updatedPoint.active,
        transform: updatedPoint.transform,
        metricType: updatedPoint.metricType,
        metricUnit: updatedPoint.metricUnit,
      },
    });
  } catch (error) {
    console.error("Error updating point info:", error);
    return NextResponse.json(
      { error: "Failed to update point info" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/device/{systemId}/point/{pointId}
 *
 * Returns detailed information about a specific point.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string; pointId: string }> },
) {
  try {
    const { systemId: systemIdStr, pointId: pointIdStr } = await params;

    const systemId = parseInt(systemIdStr, 10);
    const pointId = parseInt(pointIdStr, 10);

    if (isNaN(systemId) || isNaN(pointId)) {
      return NextResponse.json(
        { error: "Invalid systemId or pointId" },
        { status: 400 },
      );
    }

    // Authenticate and authorize
    const authResult = await requireDeviceAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;
    const { device } = authResult;

    const [point] = await pointByRid(systemId, pointId);

    if (!point) {
      return NextResponse.json(
        { error: `Point ${systemId}.${pointId} not found` },
        { status: 404 },
      );
    }

    // Construct full physical path: liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}
    const fullPhysicalPath = `liveone/${device.vendorType}/${device.vendorSiteId}/${point.physicalPathTail}`;

    return NextResponse.json({
      systemId: point.systemId,
      pointId: point.index,
      physicalPath: fullPhysicalPath,
      logicalPathStem: point.logicalPathStem,
      defaultName: point.defaultName,
      subsystem: point.subsystem,
      displayName: point.displayName,
      metricType: point.metricType,
      metricUnit: point.metricUnit,
      active: point.active,
      transform: point.transform,
    });
  } catch (error) {
    console.error("Error fetching point info:", error);
    return NextResponse.json(
      { error: "Failed to fetch point info" },
      { status: 500 },
    );
  }
}
