import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { storeSystemCredentials } from "@/lib/secure-credentials";
import { VendorRegistry } from "@/lib/vendors/registry";
import { SystemsManager } from "@/lib/systems-manager";
import { uuidv7 } from "uuidv7";

export async function POST(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

      // Create the composite system
      const [newSystem] = await db
        .insert(systems)
        .values({
          ownerClerkUserId: userId,
          vendorType: "composite",
          vendorSiteId: uuidv7(), // UUIDv7 for time-ordered unique identifier
          displayName: displayName.trim(),
          status: "active",
          metadata: {
            version: 2, // Version 2 uses new mapping format
            mappings: metadata.mappings,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      console.log(
        `[Create System] Created composite system ${newSystem.id} for user ${userId}`,
      );

      // Invalidate SystemsManager cache so the new system appears immediately
      SystemsManager.clearInstance();

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

    // Create the system in the database
    const [newSystem] = await db
      .insert(systems)
      .values({
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
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    console.log(
      `[Create System] Created system ${newSystem.id} for user ${userId}`,
    );

    // Invalidate SystemsManager cache so the new system appears immediately
    SystemsManager.clearInstance();

    // Store the credentials in Clerk
    const credentialResult = await storeSystemCredentials(
      userId,
      newSystem.id,
      vendorType,
      credentials,
    );

    if (!credentialResult.success) {
      // If credential storage failed, delete the system
      await db.delete(systems).where(eq(systems.id, newSystem.id));

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
    // Check if user is authenticated
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all systems for this user
    const userSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.ownerClerkUserId, userId))
      .orderBy(desc(systems.createdAt));

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
