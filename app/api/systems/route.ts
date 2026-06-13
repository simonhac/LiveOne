import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { eq, desc } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems as pgSystems } from "@/lib/db/planetscale/schema";
import { storeSystemCredentials } from "@/lib/secure-credentials";
import { VendorRegistry } from "@/lib/vendors/registry";
import { SystemsManager } from "@/lib/systems-manager";
import { uuidv7 } from "uuidv7";
import { AREAS_TABLE } from "@/lib/areas/flags";
import { syncCompositeBindings } from "@/lib/areas/sync";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    // Get request data
    const { vendorType, credentials, systemInfo, displayName, metadata } =
      await request.json();

    // Handle composite systems differently
    if (vendorType === "composite") {
      // Validate composite system requirements
      if (!displayName || !displayName.trim()) {
        return NextResponse.json(
          { error: "Display name is required for composite systems" },
          { status: 400 },
        );
      }

      if (!metadata || !metadata.mappings) {
        return NextResponse.json(
          { error: "Composite mappings are required" },
          { status: 400 },
        );
      }

      console.log(
        `[Create System] Creating composite system for user ${userId}`,
      );

      // Create the composite system using SystemsManager
      const systemsManager = SystemsManager.getInstance();
      const newSystem = await systemsManager.createSystem({
        ownerClerkUserId: userId,
        vendorType: "composite",
        vendorSiteId: uuidv7(), // UUIDv7 for time-ordered unique identifier
        displayName: displayName.trim(),
        status: "active",
        metadata: {
          version: 2, // Version 2 uses new mapping format
          mappings: metadata.mappings,
        },
      });

      // P3 dual-write: create the typed area_bindings + composite Area alongside the metadata shim
      // and refresh the subscription registry so the new composite resolves immediately.
      if (AREAS_TABLE) {
        try {
          await syncCompositeBindings(newSystem.id);
          await buildSubscriptionRegistry();
        } catch (error) {
          console.error(
            `[Composite] Failed to sync area_bindings for new system ${newSystem.id}:`,
            error,
          );
        }
      }

      // Success!
      return NextResponse.json({
        success: true,
        systemId: newSystem.id,
        system: newSystem,
      });
    }

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
