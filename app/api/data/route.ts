import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { jsonResponse, transformDates } from "@/lib/json";
import { buildSystemPayload } from "@/lib/dashboard/serve-data";
import {
  resolveWireAddress,
  subjectForHandle,
  subjectTimezoneOffsetMin,
} from "@/lib/dashboard/subject";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";

/**
 * Live values (+ optional readings table) for one serving subject.
 *
 * ## Addressing (config-v4 Phase 13 PR 1)
 *
 * - `?areaId=ar_…`   — an Area, served AS an area (`{area, latest}`).
 * - `?deviceId=dv_…` — a device (`{device, latest}`).
 * - `?systemId=N`    — the **permanent** legacy alias. Resolved DEVICE-FIRST, which is the v3 order and
 *   the only order that preserves handle 13 (a real Sigenergy device AND a 3-member Area) at its
 *   device's own 12 points. See `lib/dashboard/subject.ts` for the precedence table (trap D-l).
 *
 * Exactly one of the three. A comma-separated `systemId` list is a BATCH request (used only by the
 * dashboard's own prefetch, `dashboardDataBatchQuery` — see lib/queries/data.ts): one request instead
 * of N, response shaped `{data: {[systemId]: <the single-subject payload>}}`. Any id that fails auth is
 * silently OMITTED from `data` (not a whole-request failure) — a batch mixes subjects with different
 * access, same as fetching them individually would. A lone id keeps the flat single-subject shape.
 * The batch leg is `systemId`-only on purpose: its response keys ARE the React Query cache keys the
 * caller seeds (`queryKeys.data(id)`), so the id grammar on the wire and in the key cannot diverge.
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
            const payload = await buildSystemPayload(
              authResult.subject,
              wantsReadings,
            );
            return [
              id,
              transformDates(
                payload,
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
    const authResult = await t.time("auth", () =>
      requireDashboardAccess(request, address.handle, t),
    );
    if (authResult instanceof NextResponse) return authResult;
    // `?areaId=` asks for the AREA leg explicitly; auth resolved the handle device-first (the locked v3
    // order), so re-take the area leg here — the ONE place the two precedences legitimately differ, and
    // only for a colliding handle. Authorization is unaffected: the same handle was just authorized, and
    // an area is never a wider scope than the device that shares its handle (it is the union that
    // CONTAINS it). Falls back to the authorized subject if the area leg somehow vanished.
    const subject =
      address.prefer === "area" && authResult.subject.kind !== "area"
        ? ((await subjectForHandle(address.handle, "area")) ??
          authResult.subject)
        : authResult.subject;
    const payload = await t.time("build", () =>
      buildSystemPayload(subject, wantsReadings, t),
    );
    // Return with automatic date formatting and field renaming
    // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime)
    return jsonResponse(payload, subjectTimezoneOffsetMin(subject), {
      headers: serverTimingHeaders(t),
    });
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
 * `include=readings` → also build the detailed readings table (the former /api/system/{id}/latest
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
