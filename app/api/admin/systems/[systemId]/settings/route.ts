import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { VendorRegistry } from "@/lib/vendors/registry";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Check if user has access to this system
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    const isAdmin = await isUserAdmin();
    const hasAccess = isAdmin || system.ownerClerkUserId === userId;

    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Get capabilities from vendor adapter
    const adapter = VendorRegistry.getAdapter(system.vendorType);
    if (!adapter) {
      return NextResponse.json(
        { error: "Vendor adapter not found" },
        { status: 500 },
      );
    }

    const availableCapabilities =
      await adapter.getPossibleCapabilities(systemId);

    // Get enabled capabilities from the database
    const enabledCapabilities = system.capabilities as string[] | null;

    return NextResponse.json({
      success: true,
      settings: {
        displayName: system.displayName,
        shortName: system.shortName,
        capabilities: enabledCapabilities || [],
      },
      availableCapabilities,
    });
  } catch (error) {
    console.error("Error fetching system settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch system settings",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    const isAdmin = await isUserAdmin();

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Get the updates from request body
    const body = await request.json();
    const { displayName, shortName, capabilities } = body;

    // Log the settings update request
    console.log("Settings update:", {
      systemId,
      displayName,
      shortName,
      capabilities,
    });

    // Validate that at least one field is being updated
    if (
      displayName === undefined &&
      shortName === undefined &&
      capabilities === undefined
    ) {
      return NextResponse.json(
        { error: "At least one field must be provided" },
        { status: 400 },
      );
    }

    // Validate displayName if provided
    if (displayName !== undefined) {
      if (typeof displayName !== "string") {
        return NextResponse.json(
          { error: "Display name must be a string" },
          { status: 400 },
        );
      }

      if (displayName.trim().length === 0) {
        return NextResponse.json(
          { error: "Display name cannot be empty" },
          { status: 400 },
        );
      }

      if (displayName.length > 100) {
        return NextResponse.json(
          { error: "Display name is too long (max 100 characters)" },
          { status: 400 },
        );
      }
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

    // Validate capabilities if provided
    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities)) {
        return NextResponse.json(
          { error: "Capabilities must be an array" },
          { status: 400 },
        );
      }

      // Validate capabilities against available capabilities
      if (capabilities.length > 0) {
        // Get system and available capabilities
        const systemsManager = SystemsManager.getInstance();
        const system = await systemsManager.getSystem(systemId);

        if (!system) {
          return NextResponse.json(
            { error: "System not found" },
            { status: 404 },
          );
        }

        const adapter = VendorRegistry.getAdapter(system.vendorType);
        if (!adapter) {
          return NextResponse.json(
            { error: "Vendor adapter not found" },
            { status: 500 },
          );
        }

        const availableCapabilities =
          await adapter.getPossibleCapabilities(systemId);
        const availableSet = new Set(availableCapabilities);

        // Check for invalid capabilities
        const invalidCaps = capabilities.filter(
          (cap: string) => !availableSet.has(cap),
        );
        if (invalidCaps.length > 0) {
          console.warn(
            `Rejecting save with invalid capabilities for system ${systemId}:`,
            invalidCaps,
          );
          return NextResponse.json(
            {
              error: "Invalid capabilities provided",
              invalidCapabilities: invalidCaps,
            },
            { status: 400 },
          );
        }
      }
    }

    // Build the update object
    const updates: {
      displayName?: string;
      shortName?: string | null;
      capabilities?: string[];
      updatedAt: Date;
    } = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) {
      updates.displayName = displayName.trim();
    }

    if (shortName !== undefined) {
      updates.shortName =
        shortName === null || shortName.trim().length === 0
          ? null
          : shortName.trim();
    }

    if (capabilities !== undefined) {
      updates.capabilities = capabilities;
    }

    // Check if shortName is already taken by another system
    if (updates.shortName) {
      const existing = await db
        .select()
        .from(systems)
        .where(
          and(
            eq(systems.shortName, updates.shortName),
            ne(systems.id, systemId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return NextResponse.json(
          {
            error: `Short name "${updates.shortName}" is already in use by ${existing[0].displayName}`,
          },
          { status: 409 },
        );
      }
    }

    // Update the system
    const result = await db
      .update(systems)
      .set(updates)
      .where(eq(systems.id, systemId))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Invalidate SystemsManager cache so next request gets fresh data
    SystemsManager.clearInstance();

    return NextResponse.json({
      success: true,
      message: "System updated successfully",
      system: {
        id: result[0].id,
        displayName: result[0].displayName,
        shortName: result[0].shortName,
        capabilities: result[0].capabilities,
      },
    });
  } catch (error) {
    console.error("Error updating system:", error);

    // Check for unique constraint violation on shortName
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Short name must be unique across all systems",
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Failed to update system",
      },
      { status: 500 },
    );
  }
}
