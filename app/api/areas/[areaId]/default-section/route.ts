import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { buildAreaStrategyForHandle } from "@/lib/capabilities/server";

/**
 * GET /api/areas/{areaId}/default-section
 *
 * The default AreaSection for an Area — its capability-derived starter card set — for the configurator's
 * "Add area" flow. Built server-side (capabilities need the point/tracker/grid layer) so the client
 * never touches vendorType. Readability is enforced the same way the seed path is: the Area must be in
 * the caller's readable set (no escalation; the PATCH that follows re-checks too).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const area = (await listReadableAreas(auth.userId)).find(
    (a) => a.id === areaId,
  );
  if (!area) {
    return NextResponse.json(
      { error: "Area not found or not readable" },
      { status: 403 },
    );
  }

  const descriptor = await buildAreaStrategyForHandle(
    area.id,
    area.legacySystemId,
  );
  return NextResponse.json({ section: descriptor.sections[0] });
}
