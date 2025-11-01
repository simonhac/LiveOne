import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isUserAdmin } from "@/lib/auth-utils";
import { VendorRegistry } from "@/lib/vendors/registry";

// Helper to parse capabilities into a readable format
function parseCapabilityLabel(seriesId: string): string {
  const parts = seriesId.split(".");

  // Subtype mappings
  const subtypeLabels: Record<string, string> = {
    solar: "Solar",
    battery: "Battery",
    load: "Load",
    grid: "Grid",
    power: "Power",
    soc: "State of Charge",
    local: "Local",
    remote: "Remote",
  };

  const subtype = parts[1];
  const extension = parts[2];

  // Start with the subtype (e.g., "solar", "battery")
  let label = subtypeLabels[subtype] || subtype;

  if (extension) {
    label += ` (${subtypeLabels[extension] || extension})`;
  }

  return label;
}

export async function GET(
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

    // Get the target system
    const [targetSystem] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1);

    if (!targetSystem) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Verify it's a composite system
    if (targetSystem.vendorType !== "composite") {
      return NextResponse.json(
        { error: "This endpoint is only for composite systems" },
        { status: 400 },
      );
    }

    // Get all systems owned by the same user (excluding the target system itself)
    const ownedSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.ownerClerkUserId, targetSystem.ownerClerkUserId!));

    // Build list of available capabilities from all owned systems
    const availableCapabilities: Array<{
      systemId: number;
      systemName: string;
      shortName: string | null;
      seriesId: string;
      label: string;
    }> = [];

    for (const system of ownedSystems) {
      // Skip the target system itself
      if (system.id === systemId) continue;

      // Skip composite systems (they don't have real capabilities)
      if (system.vendorType === "composite") continue;

      // Get adapter for this system
      const adapter = VendorRegistry.getAdapter(system.vendorType);
      if (!adapter) {
        console.warn(
          `No adapter found for system ${system.id} (${system.vendorType})`,
        );
        continue;
      }

      // Get all possible capabilities (ignores database, returns what this system could support)
      const capabilities = await adapter.getPossibleCapabilities(system.id);

      // Add each capability to the available list
      for (const seriesId of capabilities) {
        availableCapabilities.push({
          systemId: system.id,
          systemName: system.displayName,
          shortName: system.shortName,
          seriesId,
          label: parseCapabilityLabel(seriesId),
        });
      }
    }

    // Get metadata (Drizzle auto-parses with mode: "json")
    let metadata = targetSystem.metadata || null;

    // Handle legacy double-encoded data (if metadata is a string, parse it again)
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
        console.warn(
          `System ${systemId} has double-encoded metadata, parsed successfully`,
        );
      } catch (e) {
        console.error(
          `Failed to parse double-encoded metadata for system ${systemId}:`,
          e,
        );
      }
    }

    return NextResponse.json({
      success: true,
      metadata,
      availableCapabilities,
    });
  } catch (error) {
    console.error("Error fetching composite config:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch composite configuration",
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

    // Get the target system
    const [targetSystem] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1);

    if (!targetSystem) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Verify it's a composite system
    if (targetSystem.vendorType !== "composite") {
      return NextResponse.json(
        { error: "This endpoint is only for composite systems" },
        { status: 400 },
      );
    }

    // Get the mappings from request body
    const body = await request.json();
    const { mappings } = body;

    if (!mappings) {
      return NextResponse.json(
        { error: "Mappings are required" },
        { status: 400 },
      );
    }

    // Validate mappings structure
    if (
      typeof mappings !== "object" ||
      !mappings.solar ||
      !mappings.battery ||
      !mappings.load ||
      !mappings.grid
    ) {
      return NextResponse.json(
        { error: "Invalid mappings structure" },
        { status: 400 },
      );
    }

    // Validate that all arrays contain strings
    const validateArray = (arr: any, name: string) => {
      if (!Array.isArray(arr)) {
        throw new Error(`${name} must be an array`);
      }
      if (!arr.every((item) => typeof item === "string")) {
        throw new Error(`${name} must contain only strings`);
      }
    };

    try {
      validateArray(mappings.solar, "solar");
      validateArray(mappings.battery, "battery");
      validateArray(mappings.load, "load");
      validateArray(mappings.grid, "grid");
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid mappings" },
        { status: 400 },
      );
    }

    // Validate constraints (max 1 battery, max 1 grid)
    if (mappings.battery.length > 1) {
      return NextResponse.json(
        { error: "Only one battery mapping is allowed" },
        { status: 400 },
      );
    }

    if (mappings.grid.length > 1) {
      return NextResponse.json(
        { error: "Only one grid mapping is allowed" },
        { status: 400 },
      );
    }

    // Build metadata object with version
    const metadata = {
      version: 1,
      mappings,
    };

    // Update the system with new metadata
    // Note: Drizzle auto-stringifies fields with mode: "json", so pass object directly
    const result = await db
      .update(systems)
      .set({
        metadata: metadata as any,
        updatedAt: new Date(),
      })
      .where(eq(systems.id, systemId))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: "Composite configuration updated successfully",
      metadata,
    });
  } catch (error) {
    console.error("Error updating composite config:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to update composite configuration",
      },
      { status: 500 },
    );
  }
}
