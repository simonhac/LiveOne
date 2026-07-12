import { NextRequest, NextResponse } from "next/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo } from "@/lib/db/planetscale/schema";
import { eq, and } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { PointInfo } from "@/lib/point/point-info";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { userId } = await params;

    // Systems owned by this user (excluding composite/area systems and non-active systems)
    const systemsManager = SystemsManager.getInstance();
    const ownedSystems = await systemsManager.getSystemsByOwner(userId);
    const activeSystems = ownedSystems.filter((s) => s.status === "active");

    if (activeSystems.length === 0) {
      return NextResponse.json({
        success: true,
        availablePoints: [],
        referencedSystems: [],
      });
    }

    // Get all active points from these systems
    const systemIds = activeSystems.map((s) => s.id);
    const pgPoints = await requirePlanetscaleDb()
      .select()
      .from(pointInfo)
      .where(and(eq(pointInfo.active, true)));
    // Map PG rows (native timestamps) to the served shape PointInfo.from() expects.
    const points = pgPoints.map((p) => ({
      ...p,
      createdAtMs: p.createdAt ? p.createdAt.getTime() : 0,
      updatedAtMs: p.updatedAt ? p.updatedAt.getTime() : null,
    }));

    // Filter to only points from the owner's systems and build the response
    const availablePoints: Array<{
      id: string;
      logicalPath: string;
      pointName: string;
      systemId: number;
      systemName: string;
    }> = [];

    const referencedSystemIds = new Set<number>();

    for (const row of points) {
      // Skip points not from the owner's systems
      if (!systemIds.includes(row.systemId)) {
        continue;
      }

      // Skip points without a logical path
      if (!row.logicalPathStem) {
        continue;
      }

      // Find the system for this point
      const system = activeSystems.find((s) => s.id === row.systemId);
      if (!system) {
        continue;
      }

      // Create PointInfo instance for accessing helper methods
      const point = PointInfo.from(row);

      availablePoints.push({
        id: point.getReference().toString(),
        logicalPath: point.getLogicalPath()!,
        pointName: point.name,
        systemId: point.systemId,
        systemName: system.displayName,
      });

      referencedSystemIds.add(point.systemId);
    }

    // Build the referencedSystems list
    const referencedSystems = activeSystems
      .filter((s) => referencedSystemIds.has(s.id))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        ...(s.alias && { alias: s.alias }),
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
