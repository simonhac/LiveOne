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

export async function GET(request: NextRequest) {
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

    // Get all systems owned by the current user
    const ownedSystems = await db
      .select()
      .from(systems)
      .where(eq(systems.ownerClerkUserId, userId));

    // Build list of available capabilities from all owned systems
    const availableCapabilities: Array<{
      systemId: number;
      systemName: string;
      shortName: string | null;
      seriesId: string;
      label: string;
    }> = [];

    for (const system of ownedSystems) {
      // Skip composite systems - we don't want to nest composites
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

    return NextResponse.json({
      success: true,
      availableCapabilities,
    });
  } catch (error) {
    console.error("Error fetching composite capabilities:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch composite capabilities",
      },
      { status: 500 },
    );
  }
}
