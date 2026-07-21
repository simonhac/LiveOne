import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { buildAreaStrategyForHandle } from "@/lib/capabilities/server";
import {
  createDashboard,
  listAccessibleDashboards,
  DashboardAliasTakenError,
} from "@/lib/dashboard/dashboards";
import { emptyCompositionDescriptor } from "@/lib/dashboard/composition";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";

/**
 * Composition-first dashboards (Phase 2b-2), owner-scoped.
 *   GET  /api/dashboards            → the caller's dashboards (owned ∪ shared-with-them; each tagged)
 *   POST /api/dashboards            → create one ({ displayName, alias?, seedAreaId? })
 *
 * `seedAreaId` (optional) prefills the new dashboard with that Area's default card set — a starting
 * convenience, not a home. It must be an Area the caller can read (no escalation).
 */
export async function GET(request: NextRequest) {
  const t = makeTimer(request);
  const auth = await requireAuth(request, t);
  if (auth instanceof NextResponse) return auth;
  const dashboards = await t.time("list", () =>
    listAccessibleDashboards(auth.userId),
  );
  return NextResponse.json({ dashboards }, { headers: serverTimingHeaders(t) });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) {
    return NextResponse.json(
      { error: "displayName is required" },
      { status: 400 },
    );
  }
  const alias =
    typeof body?.alias === "string" && body.alias.trim()
      ? body.alias.trim()
      : null;
  const seedAreaId =
    typeof body?.seedAreaId === "string" ? body.seedAreaId : null;

  // Seed from an Area's defaults, or start empty. The seed Area must be readable by the caller.
  let descriptor = emptyCompositionDescriptor();
  if (seedAreaId) {
    const area = (await listReadableAreas(auth.userId)).find(
      (a) => a.id === seedAreaId,
    );
    if (!area) {
      return NextResponse.json(
        { error: "seedAreaId is not an area you can read" },
        { status: 403 },
      );
    }
    descriptor = await buildAreaStrategyForHandle(area.id, area.legacySystemId);
  }

  try {
    const id = await createDashboard({
      ownerClerkUserId: auth.userId,
      displayName,
      alias,
      descriptor,
    });
    return NextResponse.json({ id });
  } catch (err) {
    if (err instanceof DashboardAliasTakenError) {
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    }
    throw err;
  }
}
