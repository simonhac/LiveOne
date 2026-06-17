import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { eq, desc } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems as pgSystems } from "@/lib/db/planetscale/schema";
import { storeSystemCredentials } from "@/lib/secure-credentials";
import { VendorRegistry } from "@/lib/vendors/registry";
import { SystemsManager } from "@/lib/systems-manager";

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    // Get request data
    const { vendorType, credentials, systemInfo } = await request.json();

    // Handle regular systems
    if (!credentials || !systemInfo?.vendorSiteId) {
      return NextResponse.json(
        {
          error: "Credentials and system info with vendorSiteId are required",
        },
        { status: 400 },
      );
    }

    // Get the vendor adapter to verify it's supported
    const adapter = VendorRegistry.getAdapter(vendorType);

    if (!adapter) {
      return NextResponse.json(
        { error: `Unknown vendor type: ${vendorType}` },
        { status: 400 },
      );
    }

    if (!adapter.supportsAddSystem) {
      return NextResponse.json(
        {
          error: `${adapter.displayName} does not support automatic system addition`,
        },
        { status: 400 },
      );
    }

    console.log(
      `[Create System] Creating ${vendorType} system for user ${userId}`,
    );

    // Allow multiple systems for the same vendor site
    // This is useful for testing, multiple users monitoring the same site, etc.

    // Create the system using SystemsManager
    const systemsManager = SystemsManager.getInstance();
    const newSystem = await systemsManager.createSystem({
      ownerClerkUserId: userId,
      vendorType,
      vendorSiteId: systemInfo.vendorSiteId,
      status: "active",
      displayName: systemInfo.displayName || `${adapter.displayName} System`,
      model: systemInfo.model || null,
      serial: systemInfo.serial || null,
      ratings: systemInfo.ratings || null,
      solarSize: systemInfo.solarSize || null,
      batterySize: systemInfo.batterySize || null,
      timezoneOffsetMin: 600, // Default to AEST
    });

    // Store the credentials in Clerk
    const credentialResult = await storeSystemCredentials(
      userId,
      newSystem.id,
      vendorType,
      credentials,
    );

    if (!credentialResult.success) {
      // If credential storage failed, delete the system.
      // Routed through SystemsManager so the rollback honours CONFIG_WRITES_TO_PG.
      await systemsManager.deleteSystem(newSystem.id);

      return NextResponse.json(
        { error: credentialResult.error || "Failed to store credentials" },
        { status: 500 },
      );
    }

    // Success!
    return NextResponse.json({
      success: true,
      systemId: newSystem.id,
    });
  } catch (error) {
    console.error("[Create System] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create system",
      },
      { status: 500 },
    );
  }
}

// GET endpoint to list user's systems
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    // Get all systems for this user
    const userSystems = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .where(eq(pgSystems.ownerClerkUserId, userId))
      .orderBy(desc(pgSystems.createdAt));

    return NextResponse.json({
      systems: userSystems,
    });
  } catch (error) {
    console.error("[List Systems] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch systems",
      },
      { status: 500 },
    );
  }
}
