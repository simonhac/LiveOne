import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte } from "drizzle-orm";
import { requireDashboardAccess } from "@/lib/api-auth";
import { parseDateRange } from "@/lib/date-utils";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  pointReadingsFlow1d,
  pointReadingsFlowAttr1d,
} from "@/lib/db/planetscale/schema";
import { toDailyFlowMatrices } from "@/lib/aggregation/flow-node-meta";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";

/**
 * GET /api/energy-flow-matrix?systemId=&start=&end=&source=legacy|modern
 *
 * Serves the dashboard's long-range (30-day / month / arbitrary) energy-flow Sankey as RAW per-day
 * matrices for the completed local days in [start, end] (`YYYY-MM-DD`, inclusive) — it does NOT sum here.
 * `source=legacy` (default) reads `point_readings_flow_1d` (energy only); `source=modern` reads the
 * superset `point_readings_flow_attr_1d` and ALSO carries the attributed metric legs (emissions /
 * renewable / cost / estimated) per edge — the client draws the Sankey from energy and derives the
 * provenance summary (cost / %renewable / emissions per load) from the same rows. The client sums the days for the
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

    // `source=modern` reads the SUPERSET table point_readings_flow_attr_1d (energy + attributed
    // emissions/renewable/cost/estimated per edge); `legacy` (default) reads flow_1d (energy only —
    // today's Sankey, untouched). Both return the SAME raw per-day per-edge shape (the client sums for
    // the window, indexes one day for hover); modern just carries a few more columns. The PK
    // (area_id, day, source_path, load_path) means each (day, source, load) appears at most once.
    const source =
      searchParams.get("source") === "modern" ? "modern" : "legacy";

    type FlowRow = {
      day: string;
      sourcePath: string;
      loadPath: string;
      energyKwh: unknown;
      emissionsG?: unknown;
      renewableKwh?: unknown;
      costC?: unknown;
      estimatedKwh?: unknown;
    };
    let rows: FlowRow[] = [];
    if (logicalSystem) {
      if (source === "modern") {
        rows = await planetscaleDb
          .select({
            day: pointReadingsFlowAttr1d.day,
            sourcePath: pointReadingsFlowAttr1d.sourcePath,
            loadPath: pointReadingsFlowAttr1d.loadPath,
            energyKwh: pointReadingsFlowAttr1d.energyKwh,
            emissionsG: pointReadingsFlowAttr1d.emissionsG,
            renewableKwh: pointReadingsFlowAttr1d.renewableKwh,
            costC: pointReadingsFlowAttr1d.costC,
            estimatedKwh: pointReadingsFlowAttr1d.estimatedKwh,
          })
          .from(pointReadingsFlowAttr1d)
          .where(
            and(
              eq(pointReadingsFlowAttr1d.areaId, logicalSystem.areaId),
              gte(pointReadingsFlowAttr1d.day, startDate.toString()),
              lte(pointReadingsFlowAttr1d.day, endDate.toString()),
            ),
          );
      } else {
        rows = await planetscaleDb
          .select({
            day: pointReadingsFlow1d.day,
            sourcePath: pointReadingsFlow1d.sourcePath,
            loadPath: pointReadingsFlow1d.loadPath,
            energyKwh: pointReadingsFlow1d.energyKwh,
          })
          .from(pointReadingsFlow1d)
          .where(
            and(
              eq(pointReadingsFlow1d.areaId, logicalSystem.areaId),
              gte(pointReadingsFlow1d.day, startDate.toString()),
              lte(pointReadingsFlow1d.day, endDate.toString()),
            ),
          );
      }
    }

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

    // Reshape into raw per-day matrices over the window's canonical-sorted union of nodes; the shared
    // helper resolves node labels/colors and (for modern) builds the metric-leg matrices alongside energy.
    return NextResponse.json(
      toDailyFlowMatrices(rows, displayNameByStem, source === "modern"),
    );
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
