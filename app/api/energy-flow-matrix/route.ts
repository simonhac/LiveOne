import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { requireSystemAccess } from "@/lib/api-auth";
import { parseDateRange } from "@/lib/date-utils";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsFlow1d, pointInfo } from "@/lib/db/planetscale/schema";
import {
  colorForFlowPath,
  labelForFlowPath,
  compareSourcePaths,
  compareLoadPaths,
} from "@/lib/aggregation/flow-node-meta";
import type {
  EnergyFlowMatrix,
  EnergyFlowNode,
} from "@/lib/energy-flow-matrix";

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

    // Configured display names by logical-path stem (for sub-meters / master load / solar).
    const points = await planetscaleDb
      .select({
        stem: pointInfo.logicalPathStem,
        displayName: pointInfo.displayName,
      })
      .from(pointInfo)
      .where(eq(pointInfo.systemId, systemId));
    const displayNameByStem = new Map<string, string>();
    for (const p of points) {
      if (p.stem && !displayNameByStem.has(p.stem)) {
        displayNameByStem.set(p.stem, p.displayName);
      }
    }

    // Distinct, canonically-ordered source/load paths.
    const sourcePaths = [...new Set(rows.map((r) => r.sourcePath))].sort(
      compareSourcePaths,
    );
    const loadPaths = [...new Set(rows.map((r) => r.loadPath))].sort(
      compareLoadPaths,
    );
    const sourceIdx = new Map(sourcePaths.map((p, i) => [p, i]));
    const loadIdx = new Map(loadPaths.map((p, i) => [p, i]));

    // Dense matrix + totals.
    const matrix: number[][] = sourcePaths.map(() =>
      new Array<number>(loadPaths.length).fill(0),
    );
    const sourceTotals = new Array<number>(sourcePaths.length).fill(0);
    const loadTotals = new Array<number>(loadPaths.length).fill(0);
    let totalEnergy = 0;
    for (const r of rows) {
      const s = sourceIdx.get(r.sourcePath)!;
      const l = loadIdx.get(r.loadPath)!;
      const energy = Number(r.energyKwh) || 0;
      matrix[s][l] = energy;
      sourceTotals[s] += energy;
      loadTotals[l] += energy;
      totalEnergy += energy;
    }

    const toNode = (path: string): EnergyFlowNode => ({
      id: path,
      label: labelForFlowPath(path, displayNameByStem),
      color: colorForFlowPath(path),
    });

    const result: EnergyFlowMatrix = {
      sources: sourcePaths.map(toNode),
      loads: loadPaths.map(toNode),
      matrix,
      sourceTotals,
      loadTotals,
      totalEnergy,
    };

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
