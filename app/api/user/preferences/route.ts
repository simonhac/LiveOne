import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  getOrCreateUserPreferences,
  setDefaultSystem,
  setDefaultDashboardById,
  clearDefaultDashboard,
} from "@/lib/user-preferences";

// GET /api/user/preferences - Get current user preferences
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    const preferences = await getOrCreateUserPreferences(userId);

    return NextResponse.json({
      success: true,
      preferences,
    });
  } catch (error) {
    console.error("Error fetching user preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch preferences" },
      { status: 500 },
    );
  }
}

// PATCH /api/user/preferences - Update user preferences
export async function PATCH(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    const body = await request.json();
    const { defaultSystemId, defaultDashboardId } = body;

    // Composition-first default (Phase 2b-2): set the default to a named dashboard by its id, or pass
    // null to clear the default landing entirely.
    if (defaultDashboardId !== undefined) {
      if (defaultDashboardId === null) {
        await clearDefaultDashboard(userId);
        return NextResponse.json({
          success: true,
          message: "Default dashboard cleared",
        });
      }
      if (typeof defaultDashboardId !== "number") {
        return NextResponse.json(
          { error: "defaultDashboardId must be a number or null" },
          { status: 400 },
        );
      }
      const result = await setDefaultDashboardById(userId, defaultDashboardId);
      if (!result.success) {
        const status = result.error === "not_found" ? 404 : 403;
        const error =
          result.error === "not_found" ? "Dashboard not found" : result.error;
        return NextResponse.json({ error }, { status });
      }
      return NextResponse.json({
        success: true,
        message: "Default dashboard updated",
      });
    }

    // Validate defaultSystemId is provided (can be null to clear)
    if (defaultSystemId === undefined) {
      return NextResponse.json(
        { error: "defaultSystemId is required (use null to clear)" },
        { status: 400 },
      );
    }

    // Validate type
    if (defaultSystemId !== null && typeof defaultSystemId !== "number") {
      return NextResponse.json(
        { error: "defaultSystemId must be a number or null" },
        { status: 400 },
      );
    }

    // Set default system (validates access internally)
    const result = await setDefaultSystem(userId, defaultSystemId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 403 });
    }

    return NextResponse.json({
      success: true,
      message: defaultSystemId
        ? "Default system updated"
        : "Default system cleared",
    });
  } catch (error) {
    console.error("Error updating user preferences:", error);
    return NextResponse.json(
      { error: "Failed to update preferences" },
      { status: 500 },
    );
  }
}
