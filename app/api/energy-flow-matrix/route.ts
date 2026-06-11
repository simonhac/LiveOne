import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { requireSystemAccess } from "@/lib/api-auth";
import { parseDateRange } from "@/lib/date-utils";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsFlow1d } from "@/lib/db/planetscale/schema";
import { toEnergyFlowMatrix } from "@/lib/aggregation/flow-node-meta";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";

/**
 * GET /api/energy-flow-matrix?systemId=&start=&end=
 *
 * Serves the dashboard's long-range (30-day / month / arbitrary) energy-flow Sankey from the
 * materialized `point_readings_flow_1d`, summing the completed local days in [start, end]
 * (`YYYY-MM-DD`, inclusive). `day` is stored as text and sorts chronologically, so a plain
 * range filter + `SUM(energy_kwh) GROUP BY (source_path, load_path)` gives the range matrix —
 * energy is additive across days (see docs/architecture/ENERGY-FLOW-MATRIX.md).
 *
 * v1: completed days only — the live partial "today so far" is NOT integrated here. Node
 * labels/colors resolve from the canonical paths via `lib/aggregation/flow-node-meta.ts`, so
 * this matches the browser Sankey by construction. Returns the `EnergyFlowMatrix` shape the
 * `EnergyFlowSankey` component consumes directly.
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

    // Authenticate and authorize (owner, viewer, or admin).
    const authResult = await requireSystemAccess(request, systemId);
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

    // Sum each (source, load) flow over the completed days in range.
    const rows = await planetscaleDb
      .select({
        sourcePath: pointReadingsFlow1d.sourcePath,
        loadPath: pointReadingsFlow1d.loadPath,
        energyKwh: sql<number>`sum(${pointReadingsFlow1d.energyKwh})`,
      })
      .from(pointReadingsFlow1d)
      .where(
        and(
          eq(pointReadingsFlow1d.systemId, systemId),
          gte(pointReadingsFlow1d.day, startDate.toString()),
          lte(pointReadingsFlow1d.day, endDate.toString()),
        ),
      )
      .groupBy(pointReadingsFlow1d.sourcePath, pointReadingsFlow1d.loadPath);

    // Resolve the logical system for display names (keyed by stem; works for composites, whose
    // points live on child systems) and to explain an empty result.
    const logicalSystem = await resolveLogicalSystem(systemId);
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
      return NextResponse.json({
        sources: [],
        loads: [],
        matrix: [],
        sourceTotals: [],
        loadTotals: [],
        totalEnergy: 0,
        reason,
      });
    }

    // Build the dense (unsorted) summed matrix from the grouped rows; the shared presenter sorts
    // canonically, resolves node labels/colors, and computes totals — same as the sub-daily path.
    const sourcePaths = [...new Set(rows.map((r) => r.sourcePath))];
    const loadPaths = [...new Set(rows.map((r) => r.loadPath))];
    const sourceIdx = new Map(sourcePaths.map((p, i) => [p, i]));
    const loadIdx = new Map(loadPaths.map((p, i) => [p, i]));
    const matrix: number[][] = sourcePaths.map(() =>
      new Array<number>(loadPaths.length).fill(0),
    );
    for (const r of rows) {
      matrix[sourceIdx.get(r.sourcePath)!][loadIdx.get(r.loadPath)!] =
        Number(r.energyKwh) || 0;
    }

    return NextResponse.json(
      toEnergyFlowMatrix(sourcePaths, loadPaths, matrix, displayNameByStem),
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
