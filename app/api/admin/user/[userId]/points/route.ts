import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, and } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { userId } = await params;

    // Get all systems using SystemsManager
    const systemsManager = SystemsManager.getInstance();
    const allSystems = await systemsManager.getAllSystems();

    // Filter to systems owned by this user (excluding composite systems)
    const nonCompositeSystems = allSystems.filter(
      (s) => s.ownerClerkUserId === userId && s.vendorType !== "composite",
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

    // Filter to only points from the owner's systems and build the response
    const availablePoints: Array<{
      id: string;
      path: string;
      name: string;
      systemId: number;
      systemName: string;
      metricType: string;
    }> = [];

    const referencedSystemIds = new Set<number>();

    for (const point of points) {
      // Skip points not from the owner's systems
      if (!systemIds.includes(point.systemId)) {
        continue;
      }

      // Skip points without a logical path
      if (!point.logicalPathStem) {
        continue;
      }

      // Use logical path stem as the path
      const path = point.logicalPathStem;

      // Find the system for this point
      const system = nonCompositeSystems.find((s) => s.id === point.systemId);
      if (!system) {
        continue;
      }

      // Build the point ID in format "systemId.pointId"
      const id = `${point.systemId}.${point.index}`;

      availablePoints.push({
        id,
        path,
        name: point.displayName || point.defaultName,
        systemId: point.systemId,
        systemName: system.displayName,
        metricType: point.metricType,
      });

      referencedSystemIds.add(point.systemId);
    }

    // Build the referencedSystems list
    const referencedSystems = nonCompositeSystems
      .filter((s) => referencedSystemIds.has(s.id))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        alias: s.alias,
      }));

    return NextResponse.json({
      success: true,
      availablePoints,
      referencedSystems,
    });
  } catch (error) {
    console.error("Error fetching available points for user:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch available points",
      },
      { status: 500 },
    );
  }
}
