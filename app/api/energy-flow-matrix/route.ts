import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { requireDashboardAccess } from "@/lib/api-auth";
import { parseDateRange } from "@/lib/date-utils";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsFlow1d } from "@/lib/db/planetscale/schema";
import { toDailyFlowMatrices } from "@/lib/aggregation/flow-node-meta";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";

/**
 * GET /api/energy-flow-matrix?systemId=&start=&end=
 *
 * Serves the dashboard's long-range (30-day / month / arbitrary) energy-flow Sankey from the
 * materialized `point_readings_flow_1d`, as RAW per-day matrices for the completed local days in
 * [start, end] (`YYYY-MM-DD`, inclusive) — it does NOT sum here. The client sums the days for the
 * window view and indexes a single day for the hovered view, so the hovered Sankey shows that day's
 * real energy (not a power snapshot). `day` is stored as text and sorts chronologically.
 *
 * v1: completed days only — the live partial "today so far" is NOT integrated here. Node
 * labels/colors resolve from the canonical paths via `lib/aggregation/flow-node-meta.ts`, so
 * this matches the browser Sankey by construction. Returns the `DailyFlowMatrices` shape the
 * client reduces into the `EnergyFlowMatrix` the `EnergyFlowSankey` component consumes.
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

    // Resolve the logical system first: for display names (keyed by stem; works for composites,
    // whose points live on child systems), to explain an empty result, and to key the flow query on
    // the view's `area_id` (P3-tail-1: `area_id` is point_readings_flow_1d's primary key). A null
    // logicalSystem (no Area resolved) falls through to the empty-result branch below.
    const logicalSystem = await resolveLogicalSystem(systemId);

    const viewFilter = logicalSystem
      ? eq(pointReadingsFlow1d.areaId, logicalSystem.areaId)
      : sql`false`;

    // Raw per-day (source, load) flows over the completed days in range — NOT summed (the client
    // sums for the window view, indexes one day for the hovered view). The PK is
    // (area_id, day, source_path, load_path), so each (day, source, load) appears at most once.
    const rows = await planetscaleDb
      .select({
        day: pointReadingsFlow1d.day,
        sourcePath: pointReadingsFlow1d.sourcePath,
        loadPath: pointReadingsFlow1d.loadPath,
        energyKwh: pointReadingsFlow1d.energyKwh,
      })
      .from(pointReadingsFlow1d)
      .where(
        and(
          viewFilter,
          gte(pointReadingsFlow1d.day, startDate.toString()),
          lte(pointReadingsFlow1d.day, endDate.toString()),
        ),
      );

    const displayNameByStem = new Map<string, string>();
    for (const p of logicalSystem?.points ?? []) {
      if (!displayNameByStem.has(p.stem)) {
        displayNameByStem.set(p.stem, p.displayName);
      }
    }

    // Empty is ambiguous — say why, so a blank Sankey isn't read as "no energy".
    if (rows.length === 0) {
      const reason =
        !logicalSystem || !logicalSystem.isComplete
          ? "not-a-logical-system"
          : "not-materialized";
      return NextResponse.json({ sources: [], loads: [], days: [], reason });
    }

    // Reshape into raw per-day matrices over the window's canonical-sorted union of nodes; the
    // shared helper resolves node labels/colors, same as the sub-daily path.
    return NextResponse.json(toDailyFlowMatrices(rows, displayNameByStem));
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
