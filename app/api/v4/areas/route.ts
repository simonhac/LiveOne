import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listReadableAreas } from "@/lib/areas/list";
import { mergeAreaLocation } from "@/lib/areas/location";
import {
  locationPatchFromBody,
  resolveMemberDeviceRefs,
} from "@/lib/areas/http";
import {
  createArea,
  refreshAreaServing,
  AreaAliasTakenError,
} from "@/lib/areas/create";
import { Area } from "@/lib/ids";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/**
 * config-v4 areas collection (§9.2), TypeID-native. The readable set (areas the caller owns ∪ areas
 * whose handle is a device they can see) a v4 editor lists to add an area or pick a seed source.
 *   GET  → { areas: [{ id: ar_…, displayName, legacySystemId, chartCapable }] }
 *   POST { name, slug?, members:[dv_…], location?, dayOffsetMin?, displayTimezone? } → 201 { id, legacySystemId }
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

/**
 * POST — create a multi-device "site" area. The v4 twin of `POST /api/areas`.
 *
 * Body (§9.2): `{ name, slug?, members: [dv_…], location?, dayOffsetMin?, displayTimezone? }`. The
 * differences from the legacy twin's body are all TypeID/vocabulary substitutions, one per key:
 * `displayName`→`name`, `alias`→`slug`, `memberSystemIds:[int]`→`members:[dv_…]`, and
 * `timezoneOffsetMin`→`dayOffsetMin` (§7 / locked decision 9 make the fixed day offset canonical;
 * `updateAreaMeta`/`createArea` still write both columns from the one number).
 *
 * The RESPONSE is deliberately key-identical to the legacy twin's — `{ id, legacySystemId }` — because
 * `legacySystemId` is the integer address every card's `/api/data?systemId=` fetch is made against, and
 * the create dialog switches straight into edit mode on it. Only the status differs: 201, as
 * `POST /api/v4/dashboards` returns.
 *
 * The area is owner-scoped (owner forced to the caller) and always gets a SYNTHETIC handle, so it can
 * grow from one member to many without re-keying. Each member must be READABLE by the caller
 * (`resolveMemberDeviceRefs`, the §8.4 no-escalation firewall). Timezone defaults from the first member.
 *   403 unreadable/unknown member · 409 slug taken · 422 bad body.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name)
    return NextResponse.json({ error: "name is required" }, { status: 422 });
  const slug =
    typeof body?.slug === "string" && body.slug.trim()
      ? body.slug.trim()
      : null;

  const members = await resolveMemberDeviceRefs(
    auth.userId,
    auth.isAdmin,
    body?.members,
  );
  if (!members.ok)
    return NextResponse.json(
      { error: members.message },
      { status: members.status },
    );

  // Day offset + display timezone default from the FIRST member device, as the legacy twin does.
  const first = await DeviceConfigRegistry.deviceByHandle(members.systemIds[0]);
  const dayOffsetMin =
    typeof body?.dayOffsetMin === "number"
      ? body.dayOffsetMin
      : (first?.timezoneOffsetMin ?? 600);
  const displayTimezone =
    typeof body?.displayTimezone === "string" && body.displayTimezone
      ? body.displayTimezone
      : (first?.displayTimezone ?? "Australia/Sydney");

  const location = body?.location
    ? mergeAreaLocation(null, locationPatchFromBody(body.location))
    : null;

  try {
    const created = await createArea({
      ownerClerkUserId: auth.userId,
      displayName: name,
      alias: slug,
      timezoneOffsetMin: dayOffsetMin,
      displayTimezone,
      location,
      memberSystemIds: members.systemIds,
    });
    // 🛑 Membership, KV and the point-series cache all key off this — never return before it runs.
    await refreshAreaServing(created.id);
    return NextResponse.json(
      { id: Area.encode(created.id), legacySystemId: created.legacySystemId },
      { status: 201 },
    );
  } catch (err) {
    // 🛑 An alias collision must be a 409 with a body, not a bare 500. `AreaAliasTakenError` is only
    // raised at all because `isUniqueViolationOn` (lib/db/pg-error.ts) walks drizzle's `cause` chain AND
    // reads the index name out of the server message — see stage 2b (#314). Do not "simplify" either half.
    if (err instanceof AreaAliasTakenError)
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    throw err;
  }
}
