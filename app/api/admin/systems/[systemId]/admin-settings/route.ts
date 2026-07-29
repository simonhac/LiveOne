/**
 * Per-system admin settings. This used to carry a `viewers` set as well, read from and written to
 * `user_systems`; that table (and the AdminTab UI section that drove it) died in migration 0045
 * (config-v4 Phase 12 slice F). Per-person sharing is `dashboard_grants` + `share_tokens`, so the only
 * thing left here is the system's owner.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { DeviceConfigRegistry } from "\@/lib/registry/device-config";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const params = await context.params;
    const systemId = parseInt(params.systemId);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    // Get the system to find the owner (read via SystemsManager → honours CONFIG_SERVE_FROM_PG)
    const system = await DeviceConfigRegistry.deviceByHandle(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      ownerClerkUserId: system.ownerClerkUserId,
    });
  } catch (error) {
    console.error("Error fetching admin settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch admin settings",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const params = await context.params;
    const systemId = parseInt(params.systemId);

    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const body = await request.json();
    const { ownerClerkUserId } = body;

    // Verify system exists (read via SystemsManager → honours CONFIG_SERVE_FROM_PG)
    const system = await DeviceConfigRegistry.deviceByHandle(systemId);

    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update owner if changed
    if (ownerClerkUserId !== undefined) {
      await SystemsManager.getInstance().updateSystem(systemId, {
        ownerClerkUserId: ownerClerkUserId || null,
      });
    }

    return NextResponse.json({
      success: true,
      message: "Admin settings updated successfully",
    });
  } catch (error) {
    console.error("Error updating admin settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to update admin settings",
      },
      { status: 500 },
    );
  }
}
