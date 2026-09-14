import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  getOrCreateUserPreferences,
  setDefaultDashboardById,
  clearDefaultDashboard,
  setDefaultArea,
  checkDefaultArea,
  checkDefaultDashboard,
  writeBothDefaults,
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

// PATCH /api/user/preferences - Update the default landing dashboard and/or the default area
export async function PATCH(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { userId } = authResult;

    const body = await request.json();
    const { defaultDashboardId, defaultAreaId } = body;

    // 🛑 `defaultAreaId` is a SEPARATE preference from the landing dashboard: it is where a newly
    // onboarded device is PLACED (migration 0073, `lib/areas/onboarding.ts`), not where the user
    // lands. It only self-populates from a user's FIRST area, so for an owner who already has
    // several this route is the only way to set one — deliberately, because guessing which of
    // their sites a new inverter belongs to would be worse than asking.
    //
    // 🛑 EVERY FIELD IS VALIDATED BEFORE ANY FIELD IS WRITTEN. An earlier cut wrote the area and
    // then validated the dashboard, so `{ defaultAreaId: <valid>, defaultDashboardId: 42 }`
    // answered 400 having already changed where the caller's next device would land — a refusal
    // that silently half-applied. The two columns are still two UPDATEs, so an infrastructure
    // fault between them can still split; what can no longer happen is a VALIDATION failure that
    // leaves state behind, and validation failures are the only ones a caller can provoke.
    if (
      defaultAreaId !== undefined &&
      defaultAreaId !== null &&
      typeof defaultAreaId !== "string"
    )
      return NextResponse.json(
        { error: "defaultAreaId must be an ar_ id or null" },
        { status: 400 },
      );
    if (
      defaultDashboardId !== undefined &&
      defaultDashboardId !== null &&
      typeof defaultDashboardId !== "string"
    )
      return NextResponse.json(
        { error: "defaultDashboardId must be a dashboard id or null" },
        { status: 400 },
      );
    if (defaultAreaId === undefined && defaultDashboardId === undefined)
      return NextResponse.json(
        {
          error:
            "defaultDashboardId or defaultAreaId is required (use null to clear)",
        },
        { status: 400 },
      );

    // 🛑 A COMBINED patch is validated and then written as ONE statement. Validating first and
    // writing twice is not enough and was the first cut of this: `setDefaultDashboardById`
    // re-resolves the dashboard, so another request deleting it between the preflight and the
    // write still answered 404 with the AREA already committed. One UPDATE, one outcome.
    if (defaultAreaId !== undefined && defaultDashboardId !== undefined) {
      const area = await checkDefaultArea(userId, defaultAreaId);
      if (!area.success) {
        const status = area.error === "not_found" ? 404 : 400;
        const error =
          area.error === "not_found" ? "Area not found" : area.error;
        return NextResponse.json({ error }, { status });
      }
      if (typeof defaultDashboardId === "string") {
        const dash = await checkDefaultDashboard(userId, defaultDashboardId);
        if (!dash.success) {
          const status = dash.error === "not_found" ? 404 : 403;
          const error =
            dash.error === "not_found" ? "Dashboard not found" : dash.error;
          return NextResponse.json({ error }, { status });
        }
      }
      await writeBothDefaults(userId, area.uuid, defaultDashboardId);
      return NextResponse.json({
        success: true,
        message: "Preferences updated",
      });
    }

    if (defaultAreaId !== undefined) {
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
    if (defaultDashboardId === null) {
      await clearDefaultDashboard(userId);
      return NextResponse.json({
        success: true,
        message: "Default dashboard cleared",
      });
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
