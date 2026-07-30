/**
 * Per-device admin settings. This used to carry a `viewers` set as well, read from and written to
 * `user_systems`; that table (and the AdminTab UI section that drove it) died in migration 0045
 * (config-v4 Phase 12 slice F). Per-person sharing is `dashboard_grants` + `share_tokens`, so the only
 * thing left here is the device's owner.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

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

    // Get the device to find the owner (config registry read)
    const device = await DeviceConfigRegistry.deviceByHandle(systemId);

    if (!device) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      ownerClerkUserId: device.ownerClerkUserId,
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

    // Verify the device exists (config registry read)
    const device = await DeviceConfigRegistry.deviceByHandle(systemId);

    if (!device) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update owner if changed
    if (ownerClerkUserId !== undefined) {
      await DeviceWriter.updateDevice(systemId, {
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
