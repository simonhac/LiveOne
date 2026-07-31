import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, requireDashboardAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  loadProvenanceArea,
  forbidUnlessOwnerAdminOrCron,
} from "@/lib/areas/provenance-auth";
import {
  LIVEONE_BIRTHDATE,
  MAX_SPAN_DAYS,
  emptyProvenanceDaily,
  readProvenanceDaily,
  resolveDayWindow,
} from "@/lib/battery-provenance/reads";

export const maxDuration = 30;

/**
 * `GET /api/v4/areas/{ar_…}/provenance-daily?start=&end=&last=` — the battery-provenance history
 * panel's read path over `battery_provenance_daily`, and the TypeID-native twin of
 * `GET /api/areas/{areaId}/provenance-daily`. Returns the DENSE columnar `ProvenanceDailyResponse`
 * (see `lib/battery-provenance/reads.ts`).
 *
 * Range defaults to the trailing year ending yesterday in the area's timezone (today's row can be a
 * checkpoint-only partial); `last` ("Nd") or `start`+`end` override. Start is clamped to the LiveOne
 * birthdate and the span capped at {@link MAX_SPAN_DAYS} days (start clamped up).
 *
 * 🛑 **AUTH — THE ONE SHAREABLE ROUTE ON THE `/api/v4` TREE.** When the area has an integer handle the
 * gate is `requireDashboardAccess` (owner/admin/viewer/public **or a per-dashboard `?access=` share
 * token**), exactly like `/api/data` and `/api/history`; otherwise it falls back to the sibling
 * provenance owner/admin/cron gate. The share-token leg is why
 * `/api/v4/areas/(.*)/provenance-daily` is in **`shareableRoutes`** (`lib/route-matchers.ts`) and not
 * `publicRoutes`: an ANONYMOUS `?access=` viewer's history panel fetches this, and `middleware.ts`
 * runs `auth.protect()` at the EDGE, so without the entry the route works perfectly for every
 * logged-in tester and 404s for every shared-dashboard viewer. That failure mode is silent in both
 * directions — it is why the smoke script drives this route with a real share token and no session.
 * The entry is suffix-surgical, and the `?access=` bypass is GET/HEAD-only in middleware, so no
 * sibling `/api/v4/areas/*` route becomes share-reachable.
 *
 * PAYLOAD: byte-for-byte the legacy twin's — the SAME `ProvenanceDailyResponse` type its client
 * (`lib/queries/provenanceDaily.ts`) already imports, including the handle spelled `systemId`.
 * Deliberately NOT re-vocabularied into the v4 areas payloads' `legacySystemId`: STEP 0's defect D2
 * showed that a v4 read which diverges from its twin breaks its client silently, and keeping the shape
 * identical makes re-pointing the query a one-line URL change.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadProvenanceArea(id);
  if ("error" in loaded) return loaded.error;
  const { area } = loaded;

  // Handled area → the shared dashboard-data gate (share-token aware); unhandled → owner/admin/cron.
  if (area.legacySystemId != null) {
    const authResult = await requireDashboardAccess(
      request,
      area.legacySystemId,
    );
    if (authResult instanceof NextResponse) return authResult;
  } else {
    const denied = forbidUnlessOwnerAdminOrCron(
      await getAuthContext(request),
      area,
    );
    if (denied) return denied;
  }

  const resolved = resolveDayWindow(
    new URL(request.url).searchParams,
    area.timezoneOffsetMin,
    "trailing-year",
  );
  if (!resolved.ok)
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  let { start } = resolved.window;
  const { end } = resolved.window;

  // A genuinely malformed request (the caller's own start is after its own end) is a 400. This check
  // must run BEFORE the birthdate clamp below — clamping a valid, merely-early `start` up to
  // LIVEONE_BIRTHDATE can itself push it past `end` (a historical window requested entirely before the
  // site existed, e.g. paging "older" back past day one) — that's an empty result, not an error.
  if (start.compare(end) > 0)
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 },
    );
  if (start.compare(LIVEONE_BIRTHDATE) < 0) start = LIVEONE_BIRTHDATE;
  if (start.compare(end) > 0)
    return NextResponse.json(
      emptyProvenanceDaily(area.uuid, area.legacySystemId, { start, end }),
    );

  // Cap the span to bound the payload — clamp start UP when a wider window was requested.
  const maxSpanStart = end.subtract({ days: MAX_SPAN_DAYS - 1 });
  if (start.compare(maxSpanStart) < 0) start = maxSpanStart;

  return NextResponse.json(
    await readProvenanceDaily(
      requirePlanetscaleDb(),
      area.uuid,
      area.legacySystemId,
      { start, end },
    ),
  );
}
