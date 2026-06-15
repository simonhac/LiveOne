import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { clearDefaultForAllUsers } from "@/lib/user-preferences";
import { SystemsManager } from "@/lib/systems-manager";
import { updateCompositeArea } from "@/lib/areas/sync";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdParam } = await params;
    const systemId = parseInt(systemIdParam);
    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const body = await request.json();
    const { status } = body;

    // Validate status
    if (!status || !["active", "disabled", "removed"].includes(status)) {
      return NextResponse.json(
        {
          error: "Invalid status. Must be one of: active, disabled, removed",
        },
        { status: 400 },
      );
    }

    // Resolve via SystemsManager — a composite resolves to its areas-backed virtual system.
    const existingSystem =
      await SystemsManager.getInstance().getSystem(systemId);

    if (!existingSystem) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update status on the right store: a composite's `areas` row, otherwise the `systems` row.
    if (existingSystem.vendorType === "composite") {
      await updateCompositeArea(systemId, { status });
      SystemsManager.invalidateCache();
    } else {
      await SystemsManager.getInstance().updateSystem(systemId, { status });
    }

    // Clear default system preference for all users if system is being removed
    if (status === "removed") {
      await clearDefaultForAllUsers(systemId);
    }

    console.log(
      `System ${systemId} status changed to ${status} by admin ${authResult.userId}`,
    );

    return NextResponse.json({
      success: true,
      system: { ...existingSystem, status, updatedAt: new Date() },
      message: `System status updated to ${status}`,
    });
  } catch (error) {
    console.error("Error updating system status:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to update system status",
      },
      { status: 500 },
    );
  }
}
