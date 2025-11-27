import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { clearDefaultForAllUsers } from "@/lib/user-preferences";

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

    // Update system status
    const updated = await db
      .update(systems)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(systems.id, systemId))
      .returning();

    if (updated.length === 0) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
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
      system: updated[0],
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
