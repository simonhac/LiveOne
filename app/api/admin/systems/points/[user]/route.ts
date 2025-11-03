import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, and } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ user: string }> },
) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { user: targetUsername } = await params;

    // Check if user is admin
    const isAdmin = await isUserAdmin();

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    // For now, we'll get all systems owned by the current user
    // In the future, you might want to resolve targetUsername to a clerkUserId
    // and fetch that user's systems instead
    const ownedSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.ownerClerkUserId, userId));

    // Filter out composite systems
    const nonCompositeSystems = ownedSystems.filter(
      (s) => s.vendorType !== "composite",
    );

    if (nonCompositeSystems.length === 0) {
      return NextResponse.json({
        success: true,
        availablePoints: [],
        referencedSystems: [],
      });
    }

    // Get all active points from these systems
    const systemIds = nonCompositeSystems.map((s) => s.id);
    const points = await db
      .select()
      .from(pointInfo)
      .where(and(eq(pointInfo.active, true)));

    // Filter to only points from the user's systems and build the response
    const availablePoints: Array<{
      id: string;
      path: string;
      name: string;
      systemId: number;
      systemName: string;
    }> = [];

    const referencedSystemIds = new Set<number>();

    for (const point of points) {
      // Skip points not from the user's systems
      if (!systemIds.includes(point.systemId)) {
        continue;
      }

      // Skip points without a series ID (type is required)
      if (!point.type) {
        continue;
      }

      // Build series ID path from type.subtype.extension.metricType
      const pathParts = [point.type, point.subtype, point.extension].filter(
        (p): p is string => Boolean(p),
      );
      const path = pathParts.join(".");

      // Find the system for this point
      const system = nonCompositeSystems.find((s) => s.id === point.systemId);
      if (!system) {
        continue;
      }

      // Build the point ID in format "systemId.pointId"
      const id = `${point.systemId}.${point.id}`;

      availablePoints.push({
        id,
        path,
        name: point.displayName || point.defaultName,
        systemId: point.systemId,
        systemName: system.displayName,
      });

      referencedSystemIds.add(point.systemId);
    }

    // Build the referencedSystems list
    const referencedSystems = nonCompositeSystems
      .filter((s) => referencedSystemIds.has(s.id))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        shortName: s.shortName,
      }));

    return NextResponse.json({
      success: true,
      availablePoints,
      referencedSystems,
    });
  } catch (error) {
    console.error("Error fetching points for user:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch points for user",
      },
      { status: 500 },
    );
  }
}
