import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { makeTimer } from "@/lib/server-timing";

/**
 * GET /api/areas/readable — the Areas the signed-in user may read, for the multi-area card picker
 * (Phase 2b) and the client-side areaId→systemId+label resolution. Authed (not share-eligible): a
 * share-token holder never enumerates the owner's areas; the shared view gets its referenced areas
 * inline from /api/dashboard-share/[token] instead.
 */
export async function GET(request: NextRequest) {
  const t = makeTimer(request);
  const auth = await requireAuth(request, t);
  if (auth instanceof NextResponse) return auth;
  const areas = await t.time("areas", () =>
    listReadableAreas(auth.userId, {
      withChartCapability: true,
    }),
  );
  return NextResponse.json(
    { areas },
    { headers: { "Server-Timing": t.header() } },
  );
}
