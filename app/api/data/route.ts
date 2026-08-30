import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { viewerControllableDevices } from "@/lib/control/ownership-server";
import { jsonResponse, transformDates } from "@/lib/json";
import { buildDevicePayload } from "@/lib/dashboard/serve-data";
import {
  resolveWireAddress,
  subjectForHandle,
  subjectTimezoneOffsetMin,
} from "@/lib/dashboard/subject";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";

/**
 * Live values (+ optional readings table) for one serving subject.
 *
 * ## Addressing
 *
 * - `?areaId=ar_…`   — an Area, served AS an area (`{area, latest}`).
 * - `?deviceId=dv_…` — a device (`{device, latest}`).
 * - `?systemId=N`    — the **permanent** legacy alias. Resolved DEVICE-FIRST — the only order that
 *   preserves handle 13 (a real Sigenergy device AND a 3-member Area) at its device's own 12 points.
 *   See `lib/dashboard/subject.ts` for the precedence table.
 *
 * Exactly one of the three. A comma-separated `systemId` list is a BATCH request: one request instead
 * of N, response shaped `{data: {[systemId]: <the single-subject payload>}}`. Any id that fails auth is
 * silently OMITTED from `data` (not a whole-request failure) — a batch mixes subjects with different
 * access, same as fetching them individually would. A lone id keeps the flat single-subject shape.
 * The batch leg is `systemId`-only on purpose: its response keys ARE the React Query cache keys a
 * caller would seed (`queryKeys.data(id)`), so the id grammar on the wire and in the key cannot
 * diverge. NOTE: the dashboard no longer uses it — SSR prefetches each handle in-process instead
 * (app/dashboard/[...slug]/page.tsx), and the client-side `dashboardDataBatchQuery` that once did
 * was removed after it was found never to have been mounted. The leg is kept because it is the
 * documented multi-subject wire form, not because something calls it.
 */
export async function GET(request: NextRequest) {
  const t = makeTimer(request);
  try {
    const { searchParams } = new URL(request.url);
    const systemIdParam = searchParams.get("systemId");
    const wantsReadings = wantsReadingsFrom(searchParams);

    // Batch leg — `systemId` only, 2+ DISTINCT ids. Dedupe BEFORE branching, exactly as before: a
    // `?systemId=7,7` collapses to one id and keeps the flat single-subject shape.
    const systemIds = systemIdParam
      ? systemIdParam
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n, i, arr) => arr.indexOf(n) === i)
      : [];
    if (systemIdParam && (systemIds.length === 0 || systemIds.some(isNaN))) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }
    if (systemIds.length > 1) {
      // Auth + build each subject concurrently; a per-id auth failure just omits that id.
      // One `batch` span covers the whole concurrent fan-out (per-id spans would interleave).
      const results = await t.time("batch", () =>
        Promise.all(
          systemIds.map(async (id) => {
            const authResult = await requireDashboardAccess(request, id);
            if (authResult instanceof NextResponse) return null;
            const payload = await buildDevicePayload(
              authResult.subject,
              wantsReadings,
            );
            // Same viewer-relative field as the single-subject leg, and it must ride INSIDE each
            // per-id entry (they are `queryKeys.data(id)` cache-seed values) rather than on the
            // envelope, so a batch entry and a single fetch have the identical shape.
            return [
              id,
              transformDates(
                {
                  ...payload,
                  canControl: viewerCanControl(authResult),
                  canControlDevices: await viewerControllableDevices(
                    authResult,
                    payload,
                  ),
                },
                subjectTimezoneOffsetMin(authResult.subject),
              ),
            ] as const;
          }),
        ),
      );
      const data = Object.fromEntries(
        results.filter((r): r is readonly [number, unknown] => r !== null),
      );
      return NextResponse.json({ data }, { headers: serverTimingHeaders(t) });
    }

    // Single subject — any of the three addresses.
    const address = await resolveWireAddress(searchParams);
    if (!address.ok) {
      return NextResponse.json(
        { error: address.error },
        { status: address.status },
      );
    }

    // Authenticate and check access (owner/admin/viewer/public, or a valid dashboard share token).
    // `auth` spans the whole access check; the threaded timer adds its inner `clerk`/`admin` splits.
    // 🛑 `address.prefer` is threaded INTO the authorization, not applied after it. `?areaId=` names the
    // AREA, which is the WIDER scope — the union that contains the device sharing its handle (13 is a
    // real Sigenergy device AND a 3-member Area). PR 1 authorized the handle device-first and then
    // re-took the area leg here without re-checking it, which held only because the point interior also
    // dispatched device-first. Phase 13 PR 2 closed that: `requireDashboardAccess` now authorizes the
    // entity the caller actually asked for, so the subject it returns is always one that was CHECKED.
    // There is deliberately no post-hoc leg swap left at this call site — that swap was the trap.
    const authResult = await t.time("auth", () =>
      requireDashboardAccess(request, address.handle, t, address.prefer),
    );
    if (authResult instanceof NextResponse) return authResult;
    const subject = authResult.subject;
    const payload = await t.time("build", () =>
      buildDevicePayload(subject, wantsReadings, t),
    );
    // Return with automatic date formatting and field renaming
    // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime).
    // `canControl` is VIEWER-relative, so it attaches here and NOT inside `buildDevicePayload`, which
    // is shared with the viewer-less SSR seed (`getDeviceDataForCache` — "access is the CALLER's
    // responsibility"). It is the display-layer input for the EV charge-control cog; the action
    // route re-authorizes with `requireOwner`, so this is courtesy, never authority.
    return jsonResponse(
      {
        ...payload,
        canControl: viewerCanControl(authResult),
        // Per-DEVICE ownership, for a tile whose commanded device is not the subject it fetched
        // under (an EV tile filed inside a multi-device area). See the helper's note.
        canControlDevices: await viewerControllableDevices(authResult, payload),
      },
      subjectTimezoneOffsetMin(subject),
      { headers: serverTimingHeaders(t) },
    );
  } catch (error) {
    console.error("API Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        timestamp: new Date(),
      },
      { status: 500 },
    );
  }
}

/**
 * The single emission point for the viewer's CONTROL access, shared by both legs.
 *
 * 🛑 This is `isOwner`, NOT `canWrite`. The control plane is owner-only — a non-owner admin is
 * refused by `requireDeviceAccess({requireOwner:true})` — so emitting `canWrite` (owner OR admin)
 * would render a cog that 403s on press, which is worse than no cog. It is derived from the SAME
 * auth result the read was authorized with; there is no second authorization path here.
 *
 * `DashboardAuthContext.isOwner` is already strict (`ownsSubject`), so the old anonymous mask is
 * subsumed: an anonymous caller on an OWNERLESS subject compares `null === null` on the raw
 * `canWrite` quirk (still pinned in `lib/__tests__/api-auth.test.ts`) but owns nothing, and a
 * share-token viewer arrives `isOwner: false`.
 */
function viewerCanControl(auth: { isOwner: boolean }): boolean {
  return auth.isOwner === true;
}

/**
 * `include=readings` → also build the detailed readings table (the former /api/device/{id}/latest
 * route): every active point merged with its cached value, including expected-but-missing points +
 * session labels. Computed only on request so the hot dashboard poll stays lean. This makes /api/data
 * the single producer of the KV latest cache.
 */
function wantsReadingsFrom(searchParams: URLSearchParams): boolean {
  return (searchParams.get("include") || "")
    .split(",")
    .map((s) => s.trim())
    .includes("readings");
}
