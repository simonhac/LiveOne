import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { clearLatestValues } from "@/lib/latest-values-store";

/**
 * POST /api/admin/latest?action=clear
 *
 * Clears the latest readings cache for all systems.
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    if (action !== "clear") {
      return NextResponse.json(
        { error: "Invalid action. Use ?action=clear" },
        { status: 400 },
      );
    }

    // Get all system IDs
    const allSystems = await db.select().from(systems);

    // Clear latest values for each system
    let clearedCount = 0;
    for (const system of allSystems) {
      await clearLatestValues(system.id);
      clearedCount++;
    }

    console.log(
      `[Admin] Cleared latest readings cache for ${clearedCount} systems`,
    );

    return NextResponse.json({
      success: true,
      message: `Cleared latest readings cache for ${clearedCount} systems`,
      systemsCleared: clearedCount,
    });
  } catch (error) {
    console.error("Error clearing latest readings cache:", error);
    return NextResponse.json(
      { error: "Failed to clear latest readings cache" },
      { status: 500 },
    );
  }
}
