import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  getOrCreateUserPreferences,
  setDefaultSystem,
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
    const { defaultSystemId } = body;

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
