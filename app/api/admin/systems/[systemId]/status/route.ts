import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/turso";
import { systems } from "@/lib/db/turso/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { clearDefaultForAllUsers } from "@/lib/user-preferences";
import { SystemsManager } from "@/lib/systems-manager";

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

    // Confirm the system exists before updating (preserves the prior 404 that the
    // .returning() row count provided — updateSystem returns void).
    const [existingSystem] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1);

    if (!existingSystem) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Update system status. updateSystem honours CONFIG_WRITES_TO_PG and
    // invalidates the SystemsManager cache; updatedAt is stamped to now.
    await SystemsManager.getInstance().updateSystem(systemId, { status });

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
