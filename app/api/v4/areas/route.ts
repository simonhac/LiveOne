import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { Area } from "@/lib/ids";

/**
 * config-v4 areas collection (§9.2), DARK, TypeID-native. The readable set (areas the caller owns ∪ areas
 * whose handle is a system they can see) a v4 editor lists to add an area or pick a seed source.
 *   GET → { areas: [{ id: ar_…, displayName, chartCapable }] }
 * Ids are `ar_` TypeIDs (areas are uuid-PK'd today — no cutover needed to speak the public id).
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
      chartCapable: a.chartCapable ?? false,
    })),
  });
}
