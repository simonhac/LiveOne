import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pointId: string }> },
) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    const isAdmin = await isUserAdmin(userId);

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    const { pointId: pointIdStr } = await params;
    const pointId = parseInt(pointIdStr);

    if (isNaN(pointId)) {
      return NextResponse.json({ error: "Invalid point ID" }, { status: 400 });
    }

    const body = await request.json();
    const { type, subtype, extension, subsystem, name, shortName } = body;

    // Validate that at least one field is provided
    if (
      type === undefined &&
      subtype === undefined &&
      extension === undefined &&
      subsystem === undefined &&
      name === undefined &&
      shortName === undefined
    ) {
      return NextResponse.json(
        {
          error:
            "At least one field (type, subtype, extension, subsystem, name, or shortName) must be provided",
        },
        { status: 400 },
      );
    }

    // Validate shortName if provided
    if (shortName !== undefined && shortName !== null) {
      if (typeof shortName !== "string") {
        return NextResponse.json(
          { error: "Short name must be a string" },
          { status: 400 },
        );
      }

      // Empty string is treated as null (removing the short name)
      if (shortName.trim().length > 0) {
        if (!/^[a-zA-Z0-9_]+$/.test(shortName)) {
          return NextResponse.json(
            {
              error:
                "Short name can only contain letters, digits, and underscores",
            },
            { status: 400 },
          );
        }

        if (shortName.length > 200) {
          return NextResponse.json(
            { error: "Short name is too long (max 200 characters)" },
            { status: 400 },
          );
        }
      }
    }

    // Build the update object
    const updates: any = {};
    if (type !== undefined) {
      updates.type = type || null;
    }
    if (subtype !== undefined) {
      updates.subtype = subtype || null;
    }
    if (extension !== undefined) {
      updates.extension = extension || null;
    }
    if (subsystem !== undefined) {
      updates.subsystem = subsystem || null;
    }
    if (name !== undefined) {
      updates.name = name || null;
    }
    if (shortName !== undefined) {
      updates.shortName =
        shortName === null || shortName.trim().length === 0
          ? null
          : shortName.trim();
    }

    // Update the point info
    await db.update(pointInfo).set(updates).where(eq(pointInfo.id, pointId));

    // Fetch and return the updated point info
    const [updatedPoint] = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.id, pointId));

    if (!updatedPoint) {
      return NextResponse.json({ error: "Point not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      point: {
        id: updatedPoint.id,
        pointId: updatedPoint.pointId,
        pointSubId: updatedPoint.pointSubId,
        type: updatedPoint.type,
        subtype: updatedPoint.subtype,
        extension: updatedPoint.extension,
        subsystem: updatedPoint.subsystem,
        defaultName: updatedPoint.defaultName,
        name: updatedPoint.name,
        shortName: updatedPoint.shortName,
        metricType: updatedPoint.metricType,
        metricUnit: updatedPoint.metricUnit,
      },
    });
  } catch (error) {
    console.error("Error updating point info:", error);

    // Check for unique constraint violation on shortName
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      return NextResponse.json(
        {
          error:
            "UNIQUE constraint failed: short_name must be unique within system",
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: "Failed to update point info" },
      { status: 500 },
    );
  }
}
