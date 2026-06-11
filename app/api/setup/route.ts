import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems, userSystems } from "@/lib/db/planetscale/schema";
import { eq, and } from "drizzle-orm";
import { SystemsManager } from "@/lib/systems-manager";
import { grantUserSystem } from "@/lib/user-systems";

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    const body = await request.json();
    const { systemNumber } = body;

    if (!systemNumber) {
      return NextResponse.json(
        {
          success: false,
          error: "System number is required",
        },
        { status: 400 },
      );
    }

    // Check if this system exists (vendor type + site ID is the unique combination)
    const [existingSystem] = await requirePlanetscaleDb()
      .select()
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, "selectronic"),
          eq(systems.vendorSiteId, systemNumber),
        ),
      )
      .limit(1);

    if (existingSystem) {
      // Check if user already has access to this system
      const [existingAccess] = await requirePlanetscaleDb()
        .select()
        .from(userSystems)
        .where(
          and(
            eq(userSystems.clerkUserId, userId),
            eq(userSystems.systemId, existingSystem.id),
          ),
        )
        .limit(1);

      if (existingAccess) {
        return NextResponse.json({
          success: true,
          message: "You already have access to this system",
          systemId: existingSystem.id,
          role: existingAccess.role,
        });
      }

      // Add user to this existing system as a viewer
      // Routed through grantUserSystem so the write honours CONFIG_WRITES_TO_PG.
      await grantUserSystem(userId, existingSystem.id, "viewer"); // New users get viewer role by default

      return NextResponse.json({
        success: true,
        message: "System linked to your account as viewer",
        systemId: existingSystem.id,
        role: "viewer",
      });
    } else {
      // Create a new system entry
      const systemsManager = SystemsManager.getInstance();
      const newSystem = await systemsManager.createSystem({
        ownerClerkUserId: userId, // Set the creator as the owner who will hold credentials
        vendorType: "selectronic",
        vendorSiteId: systemNumber,
        status: "active",
        displayName: `System ${systemNumber}`,
        timezoneOffsetMin: 600, // Default to AEST (10 hours * 60)
        displayTimezone: "Australia/Melbourne",
      });

      // Add the user as owner of this new system
      // Routed through grantUserSystem so the write honours CONFIG_WRITES_TO_PG.
      await grantUserSystem(userId, newSystem.id, "owner"); // Creator gets owner role

      return NextResponse.json({
        success: true,
        message: "System created and linked to your account as owner",
        systemId: newSystem.id,
        role: "owner",
      });
    }
  } catch (error) {
    console.error("Setup error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to setup system",
      },
      { status: 500 },
    );
  }
}

// GET endpoint to list all systems the user has access to
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    // Get all systems this user has access to
    const userSystemRecords = await requirePlanetscaleDb()
      .select()
      .from(userSystems)
      .innerJoin(systems, eq(systems.id, userSystems.systemId))
      .where(eq(userSystems.clerkUserId, userId));

    return NextResponse.json({
      success: true,
      systems: userSystemRecords.map((record) => ({
        id: record.systems.id,
        vendorType: record.systems.vendorType,
        vendorSiteId: record.systems.vendorSiteId,
        displayName: record.systems.displayName,
        role: record.user_systems.role,
        joinedAt: record.user_systems.createdAt,
      })),
      count: userSystemRecords.length,
    });
  } catch (error) {
    console.error("Get systems error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to get systems",
      },
      { status: 500 },
    );
  }
}
