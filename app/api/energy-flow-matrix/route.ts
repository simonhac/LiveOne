import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { parseDateRange } from "@/lib/date-utils";
import { planetscaleDb } from "@/lib/db/planetscale";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import { readAttributedDailyMatrices } from "@/lib/aggregation/flow-attr-read";

/**
 * GET /api/energy-flow-matrix?systemId=&start=&end=
 *
 * Serves the dashboard's long-range (30-day / month / arbitrary) energy-flow Sankey as RAW per-day
 * matrices for the completed local days in [start, end] (`YYYY-MM-DD`, inclusive) — it does NOT sum here.
 * Reads the materialised attributed matrix `point_readings_flow_attr_1d`, so each edge carries energy
 * PLUS the attributed metric legs (emissions / renewable / cost / estimated): the client draws the
 * Sankey from energy and derives the provenance summary (cost / %renewable / emissions per load) from
 * the same rows. The client sums the days for the window view and indexes a single day for the hovered
 * view, so the hovered Sankey shows that day's real energy (not a power snapshot). `day` is stored as
 * text and sorts chronologically.
 *
 * v1: completed days only — the live partial "today so far" is NOT integrated here. Node labels/colors
 * resolve from the canonical paths via `lib/aggregation/flow-node-meta.ts`, so this matches the browser
 * Sankey by construction. The query + shaping live in `readAttributedDailyMatrices` (this route is a
 * thin auth + range wrapper over it).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const systemIdStr = searchParams.get("systemId");
    const systemId = systemIdStr ? parseInt(systemIdStr, 10) : NaN;
    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid systemId", details: "systemId must be numeric" },
        { status: 400 },
      );
    }

    // Authenticate and authorize (owner/viewer/admin/public, or a valid dashboard share token).
    const authResult = await requireDashboardAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    const startStr = searchParams.get("start");
    const endStr = searchParams.get("end");
    if (!startStr || !endStr) {
      return NextResponse.json(
        {
          error: "Missing date range",
          details: "start and end are required (YYYY-MM-DD)",
        },
        { status: 400 },
      );
    }

    let startDate, endDate;
    try {
      [startDate, endDate] = parseDateRange(startStr, endStr);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Invalid date range" },
        { status: 400 },
      );
    }

    if (!planetscaleDb) {
      return NextResponse.json(
        { error: "Database unavailable" },
        { status: 503 },
      );
    }

    // Resolve the logical system for display names (keyed by stem; works for composites), to explain an
    // empty result, and to key the flow query on the view's `area_id`. A null/incomplete system falls
    // through to the shared read's empty-with-reason result.
    const logicalSystem = await resolveLogicalSystem(systemId);
    const result = await readAttributedDailyMatrices(
      planetscaleDb,
      logicalSystem,
      startDate.toString(),
      endDate.toString(),
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("[energy-flow-matrix] error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
