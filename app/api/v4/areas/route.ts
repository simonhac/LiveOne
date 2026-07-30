import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { Area } from "@/lib/ids";

/**
 * config-v4 areas collection (§9.2), TypeID-native. The readable set (areas the caller owns ∪ areas
 * whose handle is a device they can see) a v4 editor lists to add an area or pick a seed source.
 *   GET → { areas: [{ id: ar_…, displayName, legacySystemId, chartCapable }] }
 * Ids are `ar_` TypeIDs (areas are uuid-PK'd today — no cutover needed to speak the public id).
 *
 * 🛑 `legacySystemId` is NOT vestigial and must not be "cleaned up" out of this payload before its
 * consumer moves. This route's only intended client is `readableAreasQuery` → `clientShellResolver`
 * (`components/dashboard/v4/node-view.tsx`), which turns it into `shell.handle` — the address EVERY
 * card's data fetch (`/api/data?systemId=`) is made against. The route shipped without it: because the
 * whole `/api/v4` tree was dark, and because `fetchJson<T>` is an unchecked cast, re-pointing the query
 * at this route would have compiled clean and rendered every card as a permanent skeleton — no error,
 * no 404, no console warning, nothing to grep for. Found by inspection during Phase 14 STEP 0, never by
 * a test. It goes when `/api/data` stops addressing by integer handle, and it goes from the legacy twin
 * (`GET /api/areas/readable`) at the same moment — not before.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const areas = await listReadableAreas(auth.userId, {
    withChartCapability: true,
  });
  return NextResponse.json({
    areas: areas.map((a) => ({
      id: Area.encode(a.id),
      displayName: a.displayName,
      // The integer data-addressing handle — see the header. Same key + type as the legacy twin, so
      // re-pointing `readableAreasQuery` is a one-line URL change and nothing downstream moves.
      legacySystemId: a.legacySystemId,
      chartCapable: a.chartCapable ?? false,
    })),
  });
}
