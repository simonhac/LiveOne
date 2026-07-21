import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { jsonResponse, transformDates } from "@/lib/json";
import { buildSystemPayload } from "@/lib/dashboard/serve-data";
import { makeTimer, serverTimingHeaders } from "@/lib/server-timing";

export async function GET(request: NextRequest) {
  const t = makeTimer(request);
  try {
    // Get systemId(s) from query parameters. A comma-separated list is a BATCH request (used only by
    // the dashboard's own prefetch, `dashboardDataBatchQuery` — see lib/queries/data.ts): one request
    // instead of N, response shaped `{data: {[systemId]: <the single-system payload below>}}`. Any id
    // that fails auth is silently OMITTED from `data` (not a whole-request failure) — a batch mixes
    // systems with different access, same as fetching them individually would. A lone id keeps the
    // original flat single-system shape, byte-identical to before batching existed.
    const { searchParams } = new URL(request.url);
    const systemIdParam = searchParams.get("systemId");

    if (!systemIdParam) {
      return NextResponse.json(
        {
          error: "System ID is required",
        },
        { status: 400 },
      );
    }

    const systemIds = systemIdParam
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n, i, arr) => arr.indexOf(n) === i);
    if (systemIds.length === 0 || systemIds.some((n) => isNaN(n))) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const include = (searchParams.get("include") || "")
      .split(",")
      .map((s) => s.trim());
    // `include=readings` → also build the detailed readings table (the former
    // /api/system/{id}/latest route): every active point merged with its cached value, including
    // expected-but-missing points + session labels. Computed only on request so the hot dashboard
    // poll stays lean. This makes /api/data the single producer of the KV latest cache.
    const wantsReadings = include.includes("readings");

    if (systemIds.length === 1) {
      // Authenticate and check access (owner/admin/viewer/public, or a valid dashboard share token).
      // `auth` spans the whole access check; the threaded timer adds its inner `clerk`/`admin` splits.
      const authResult = await t.time("auth", () =>
        requireDashboardAccess(request, systemIds[0], t),
      );
      if (authResult instanceof NextResponse) return authResult;
      const payload = await t.time("build", () =>
        buildSystemPayload(authResult.system, wantsReadings, t),
      );
      // Return with automatic date formatting and field renaming
      // (measurementTimeMs -> measurementTime, receivedTimeMs -> receivedTime)
      return jsonResponse(payload, authResult.system.timezoneOffsetMin, {
        headers: serverTimingHeaders(t),
      });
    }

    // Batch: auth + build each system concurrently; a per-id auth failure just omits that id.
    // One `batch` span covers the whole concurrent fan-out (per-id spans would interleave).
    const results = await t.time("batch", () =>
      Promise.all(
        systemIds.map(async (id) => {
          const authResult = await requireDashboardAccess(request, id);
          if (authResult instanceof NextResponse) return null;
          const payload = await buildSystemPayload(
            authResult.system,
            wantsReadings,
          );
          return [
            id,
            transformDates(payload, authResult.system.timezoneOffsetMin),
          ] as const;
        }),
      ),
    );
    const data = Object.fromEntries(
      results.filter((r): r is readonly [number, unknown] => r !== null),
    );
    return NextResponse.json({ data }, { headers: serverTimingHeaders(t) });
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
