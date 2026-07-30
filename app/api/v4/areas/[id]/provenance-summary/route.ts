import { NextRequest, NextResponse } from "next/server";
import { getAuthContext } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  loadProvenanceArea,
  forbidUnlessOwnerAdminOrCron,
} from "@/lib/areas/provenance-auth";
import {
  LIVEONE_BIRTHDATE,
  resolveDayWindow,
  readProvenanceSummary,
} from "@/lib/battery-provenance/reads";
import { Area } from "@/lib/ids";

export const maxDuration = 30;

/**
 * `GET /api/v4/areas/{ar_…}/provenance-summary?start=&end=&last=` — the verify half of activating or
 * repricing an Area's battery provenance, and the TypeID-native twin of
 * `GET /api/areas/{areaId}/provenance-summary`. Pairs with the recompute (materialise) endpoint so
 * activate-then-verify is two calls. Returns `sources[]`: per-source intensities over the window from
 * `point_readings_flow_attr_1d` — see `lib/battery-provenance/reads.ts` for the filtered-denominator
 * math. A generator reprice is verified here (e.g. `source.grid` → ~1000 g/kWh).
 *
 * Range defaults to the LiveOne birthdate → yesterday (full history); `last` ("Nd") or `start`+`end`
 * override. Authorized for the area's **owner**, an **admin**, or a **`CRON_SECRET` bearer** (headless
 * ops), exactly as the legacy twin.
 *
 * 🛑 That cron mode is why `/api/v4/areas/(.*)/provenance-summary` is in `publicRoutes`
 * (`lib/route-matchers.ts`): `middleware.ts` runs Clerk's `auth.protect()` at the EDGE, before the
 * handler and before any rewrite, so without the entry a headless `CRON_SECRET` call is 404'd having
 * never reached the in-handler gate. The entry is suffix-surgical — sibling `/api/v4/areas/*` routes
 * stay Clerk-gated.
 *
 * PAYLOAD: the legacy twin's keys VERBATIM (`ok`, `areaId` as `ar_`, `systemId`, `range`, `sources`).
 * Nothing renamed, nothing dropped — a v4 read that quietly narrows its payload is invisible to a
 * status-code test and fatal to whatever moves onto it (config-v4 Phase 14 STEP 0, defect D2). The
 * integer handle stays spelled `systemId` here rather than the `legacySystemId` the v4 AREA payloads
 * use, so this route and `provenance-daily` — which shares a checked-in TypeScript response type with
 * its client — keep one spelling between them.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthContext(request);
  // 401 BEFORE the lookup, as the legacy twin does — an anonymous caller learns nothing about which
  // area ids exist.
  if (!auth.userId && !auth.isCron)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const loaded = await loadProvenanceArea(id);
  if ("error" in loaded) return loaded.error;
  const denied = forbidUnlessOwnerAdminOrCron(auth, loaded.area);
  if (denied) return denied;
  const { area } = loaded;

  const resolved = resolveDayWindow(
    new URL(request.url).searchParams,
    area.timezoneOffsetMin,
    "birthdate",
  );
  if (!resolved.ok)
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  let { start } = resolved.window;
  const { end } = resolved.window;
  if (start.compare(LIVEONE_BIRTHDATE) < 0) start = LIVEONE_BIRTHDATE;
  if (start.compare(end) > 0)
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 },
    );

  const sources = await readProvenanceSummary(
    requirePlanetscaleDb(),
    area.uuid,
    {
      start,
      end,
    },
  );

  return NextResponse.json({
    ok: true,
    areaId: Area.encode(area.uuid),
    systemId: area.legacySystemId,
    range: { start: start.toString(), end: end.toString() },
    sources,
  });
}
