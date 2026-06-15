import { NextRequest, NextResponse } from "next/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo } from "@/lib/db/planetscale/schema";
import { requireAdmin } from "@/lib/api-auth";
import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";
import { SystemsManager } from "@/lib/systems-manager";
import { COMPOSITE_VALIDATED_ROLE_IDS, ROLES } from "@/lib/roles/registry";
import { bindingsToMappings } from "@/lib/areas/convert";
import { getCompositeBindingRefs } from "@/lib/areas/bindings";
import { syncCompositeBindingsFromMappings } from "@/lib/areas/sync";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Resolve via SystemsManager (a composite resolves to its areas-backed virtual system once the
    // legacy systems row is gone), then verify it's a composite.
    const targetSystem = await SystemsManager.getInstance().getSystem(systemId);

    if (!targetSystem) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    if (targetSystem.vendorType !== "composite") {
      return NextResponse.json(
        { error: "This endpoint is only for composite systems" },
        { status: 400 },
      );
    }

    // Derive the {version:2, mappings} blob from the authoritative area_bindings.
    const metadata = bindingsToMappings(
      await getCompositeBindingRefs(systemId),
    );

    return NextResponse.json({
      success: true,
      metadata,
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
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Resolve via SystemsManager (areas-backed once the legacy systems row is gone).
    const targetSystem = await SystemsManager.getInstance().getSystem(systemId);

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

    // Validate mappings structure - must be an object with string array values
    if (typeof mappings !== "object" || Array.isArray(mappings)) {
      return NextResponse.json(
        { error: "Mappings must be an object" },
        { status: 400 },
      );
    }

    // Validate that all mapping values are arrays of strings in format "systemId.pointId"
    const validateMappingArray = (arr: any, categoryName: string) => {
      if (!Array.isArray(arr)) {
        throw new Error(`${categoryName} must be an array`);
      }

      for (const item of arr) {
        if (typeof item !== "string") {
          throw new Error(`${categoryName} must contain only strings`);
        }

        // Validate format: "systemId.pointId" where both are numbers
        const parts = item.split(".");
        if (parts.length !== 2) {
          throw new Error(
            `${categoryName} mapping "${item}" must be in format "systemId.pointId"`,
          );
        }

        const [systemIdStr, pointIdStr] = parts;
        if (isNaN(parseInt(systemIdStr)) || isNaN(parseInt(pointIdStr))) {
          throw new Error(
            `${categoryName} mapping "${item}" must have numeric systemId and pointId`,
          );
        }
      }
    };

    // Validate all mapping categories
    try {
      for (const [category, value] of Object.entries(mappings)) {
        validateMappingArray(value, category);
      }
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid mappings" },
        { status: 400 },
      );
    }

    // Validate that points have compatible paths for their categories
    // Collect all point references (systemId.pointId) from mappings
    const allPointRefs = new Set<string>();
    for (const pointIds of Object.values(mappings)) {
      if (Array.isArray(pointIds)) {
        for (const pointId of pointIds) {
          allPointRefs.add(pointId);
        }
      }
    }

    // Fetch all referenced points from database
    if (allPointRefs.size > 0) {
      const points = await requirePlanetscaleDb().select().from(pointInfo);

      // Build map of "systemId.pointId" -> path
      const pointPaths = new Map<string, string>();
      for (const point of points) {
        if (point.logicalPathStem) {
          const key = `${point.systemId}.${point.index}`;
          pointPaths.set(key, point.logicalPathStem);
        }
      }

      // Helper to check if a path matches a pattern
      const matchesPattern = (path: string, pattern: string): boolean => {
        return path === pattern || path.startsWith(pattern + ".");
      };

      // Category path requirements, sourced from the role registry. Only roles flagged
      // `validatesCompositePath` are checked here (solar/battery/load/grid); other categories
      // (e.g. ev) fall through as "unknown" and are allowed unvalidated, as before.
      const categoryPathPatterns: Record<string, string> = Object.fromEntries(
        COMPOSITE_VALIDATED_ROLE_IDS.map((id) => [id, ROLES[id].stem]),
      );

      // Validate each category's points
      for (const [category, pointIds] of Object.entries(mappings)) {
        if (!Array.isArray(pointIds)) continue;

        const pattern = categoryPathPatterns[category];
        if (!pattern) {
          // Allow unknown categories (for future extensibility)
          continue;
        }

        for (const pointId of pointIds) {
          const path = pointPaths.get(pointId);

          if (!path) {
            return NextResponse.json(
              {
                error: `Point ${pointId} not found or has no type defined`,
              },
              { status: 400 },
            );
          }

          if (!matchesPattern(path, pattern)) {
            return NextResponse.json(
              {
                error: `Point ${pointId} with path "${path}" is not compatible with category "${category}"`,
              },
              { status: 400 },
            );
          }
        }
      }
    }

    // Build metadata object with version 2
    const metadata = {
      version: 2,
      mappings,
    };

    // Bindings are authoritative: write the edited mappings straight to area_bindings (no metadata
    // re-read). Let a failure surface — the editor must not silently drop an edit.
    await syncCompositeBindingsFromMappings(systemId, metadata);

    // Rollback cushion (Stages 0–2): mirror the blob into systems.metadata while the legacy systems
    // row still exists. Best-effort and a no-op once the row is gone (Stage 3 removes this).
    try {
      await SystemsManager.getInstance().updateSystem(systemId, {
        metadata: metadata as any,
      });
    } catch (error) {
      console.error(
        `[Composite] Failed to mirror metadata cushion for system ${systemId}:`,
        error,
      );
    }

    // Rebuild subscription registry to reflect the updated composite system mappings
    console.log(
      `Rebuilding subscription registry after composite system ${systemId} metadata update`,
    );
    try {
      await buildSubscriptionRegistry();
      console.log("Subscription registry rebuilt successfully");
    } catch (error) {
      // Log but don't fail the request - the metadata update was successful
      console.error("Failed to rebuild subscription registry:", error);
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
