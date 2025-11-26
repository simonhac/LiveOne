import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, and } from "drizzle-orm";
import { requireSystemAccess } from "@/lib/api-auth";

/**
 * PATCH /api/system/{systemId}/point/{pointId}
 *
 * Updates user-modifiable fields on a point_info record.
 *
 * Updatable fields:
 * - type: string | null (eg. "source", "load", "bidi")
 * - subtype: string | null (eg. "pool", "ev", "solar1")
 * - extension: string | null (additional qualifier)
 * - displayName: string | null (user-friendly name)
 * - alias: string | null (short name for API references)
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
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    // Parse request body
    const body = await request.json();

    // Validate the point exists
    const [existingPoint] = await db
      .select()
      .from(pointInfo)
      .where(
        and(eq(pointInfo.systemId, systemId), eq(pointInfo.index, pointId)),
      )
      .limit(1);

    if (!existingPoint) {
      return NextResponse.json(
        { error: `Point ${systemId}.${pointId} not found` },
        { status: 404 },
      );
    }

    // Build update object with only allowed fields
    const updateData: Record<string, any> = {};

    if (body.type !== undefined) {
      updateData.type = body.type;
    }
    if (body.subtype !== undefined) {
      updateData.subtype = body.subtype;
    }
    if (body.extension !== undefined) {
      updateData.extension = body.extension;
    }
    if (body.displayName !== undefined) {
      updateData.displayName = body.displayName;
    }
    if (body.alias !== undefined) {
      // Validate alias format if provided (letters, digits, underscore only)
      if (body.alias !== null && body.alias !== "") {
        if (!/^[a-zA-Z0-9_]+$/.test(body.alias)) {
          return NextResponse.json(
            {
              error:
                "Invalid alias format. Use only letters, digits, and underscores.",
            },
            { status: 400 },
          );
        }
      }
      updateData.alias = body.alias || null;
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

    // Perform the update
    await db
      .update(pointInfo)
      .set(updateData)
      .where(
        and(eq(pointInfo.systemId, systemId), eq(pointInfo.index, pointId)),
      );

    // Fetch the updated record
    const [updatedPoint] = await db
      .select()
      .from(pointInfo)
      .where(
        and(eq(pointInfo.systemId, systemId), eq(pointInfo.index, pointId)),
      )
      .limit(1);

    console.log(
      `[Point] Updated point ${systemId}.${pointId}:`,
      JSON.stringify(updateData),
    );

    return NextResponse.json({
      success: true,
      point: {
        systemId: updatedPoint.systemId,
        pointId: updatedPoint.index,
        type: updatedPoint.type,
        subtype: updatedPoint.subtype,
        extension: updatedPoint.extension,
        displayName: updatedPoint.displayName,
        alias: updatedPoint.alias,
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
 * GET /api/system/{systemId}/point/{pointId}
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
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    const [point] = await db
      .select()
      .from(pointInfo)
      .where(
        and(eq(pointInfo.systemId, systemId), eq(pointInfo.index, pointId)),
      )
      .limit(1);

    if (!point) {
      return NextResponse.json(
        { error: `Point ${systemId}.${pointId} not found` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      systemId: point.systemId,
      pointId: point.index,
      originId: point.originId,
      originSubId: point.originSubId,
      defaultName: point.defaultName,
      subsystem: point.subsystem,
      type: point.type,
      subtype: point.subtype,
      extension: point.extension,
      displayName: point.displayName,
      alias: point.alias,
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
