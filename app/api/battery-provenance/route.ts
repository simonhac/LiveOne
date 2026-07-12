import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { parseDateRange } from "@/lib/date-utils";
import { planetscaleDb } from "@/lib/db/planetscale";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import { getProvenanceSummary } from "@/lib/battery-provenance/summary";

/**
 * GET /api/battery-provenance?systemId=&start=&end=
 *
 * The battery-provenance period report from the attribution rollup (`point_readings_flow_attr_1d`):
 * per-load cost / %renewable / avg emissions over [start, end] (`YYYY-MM-DD`, inclusive) + the per-load
 * source split — e.g. "what did it cost / how green to charge the EV over July". Keyed on the view's
 * Area (like the energy-flow-matrix endpoint). Auth is dashboard-access (owner/viewer/admin/share-token)
 * so shared dashboards can read it.
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

    const logicalSystem = await resolveLogicalSystem(systemId);
    if (!logicalSystem) {
      return NextResponse.json({
        loads: [],
        sources: [],
        reason: "not-a-logical-system",
      });
    }

    const summary = await getProvenanceSummary(
      logicalSystem.areaId,
      startDate.toString(),
      endDate.toString(),
    );
    if (summary.loads.length === 0) {
      return NextResponse.json({ ...summary, reason: "not-materialized" });
    }
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[battery-provenance] error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
