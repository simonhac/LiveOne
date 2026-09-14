import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  getOrCreateUserPreferences,
  setDefaultDashboardById,
  clearDefaultDashboard,
  setDefaultArea,
} from "@/lib/user-preferences";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";

// GET /api/user/preferences - Get current user preferences
export async function GET(request: NextRequest) {
  try {
    const t = makeTimer(request);
    const authResult = await requireAuth(request, t);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    const preferences = await t.time("prefs", () =>
      getOrCreateUserPreferences(userId),
    );

    return NextResponse.json(
      {
        success: true,
        preferences,
      },
      { headers: serverTimingHeaders(t) },
    );
  } catch (error) {
    console.error("Error fetching user preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch preferences" },
      { status: 500 },
    );
  }
}

// PATCH /api/user/preferences - Update the default landing dashboard
export async function PATCH(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    const body = await request.json();
    const { defaultDashboardId, defaultAreaId } = body;

    // 🛑 `defaultAreaId` is a SEPARATE preference from the landing dashboard and is handled first,
    // independently: it is where a newly onboarded device is PLACED (migration 0073,
    // `lib/areas/onboarding.ts`), not where the user lands. It only self-populates from a first
    // area, so for an owner who already has several this route is the only way to set one —
    // deliberately, because guessing which of their sites a new inverter belongs to would be worse
    // than asking.
    if (defaultAreaId !== undefined) {
      if (defaultAreaId !== null && typeof defaultAreaId !== "string") {
        return NextResponse.json(
          { error: "defaultAreaId must be an ar_ id or null" },
          { status: 400 },
        );
      }
      const areaResult = await setDefaultArea(userId, defaultAreaId);
      if (!areaResult.success) {
        const status = areaResult.error === "not_found" ? 404 : 400;
        const error =
          areaResult.error === "not_found"
            ? "Area not found"
            : areaResult.error;
        return NextResponse.json({ error }, { status });
      }
      // Area-only patch: the dashboard half is genuinely optional here.
      if (defaultDashboardId === undefined)
        return NextResponse.json({
          success: true,
          message: "Default area updated",
        });
    }

    // The default landing is a composition dashboard: set it by id, or pass null to clear.
    if (defaultDashboardId === undefined) {
      return NextResponse.json(
        {
          error:
            "defaultDashboardId or defaultAreaId is required (use null to clear)",
        },
        { status: 400 },
      );
    }
    if (defaultDashboardId === null) {
      await clearDefaultDashboard(userId);
      return NextResponse.json({
        success: true,
        message: "Default dashboard cleared",
      });
    }
    if (typeof defaultDashboardId !== "string") {
      return NextResponse.json(
        { error: "defaultDashboardId must be a dashboard id or null" },
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
  } catch (error) {
    console.error("Error updating user preferences:", error);
    return NextResponse.json(
      { error: "Failed to update preferences" },
      { status: 500 },
    );
  }
}
