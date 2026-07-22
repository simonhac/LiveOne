import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import { getAuthContext, requireDashboardAccess } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { getTodayInTimezone } from "@/lib/date-utils";
import { capabilitiesForSystem } from "@/lib/capabilities/server";
import {
  computeRenewablesMetrics,
  type RenewablesEdgeAgg,
  type RenewablesSummaryResponse,
} from "@/lib/renewables/summary";

export const maxDuration = 30;

const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

/**
 * GET /api/areas/[areaId]/renewables-summary?start=&end=&last= — the `renewables` tile's data path.
 * Computes the three renewables metrics (renewable autarky · own-renewable self-consumption ·
 * renewable share of consumption; see `lib/renewables/summary.ts`) from `point_readings_flow_attr_1d`
 * over the requested local-day window, plus the estimated/energy confidence ratio.
 *
 * Range defaults to TODAY so far in the area's timezone; `last` ("Nd") or `start`+`end` override —
 * the same params as provenance-summary. NOTE (v1 limitation, shared with the Sankey rollup): the
 * modern rollup is materialised per COMPLETED local day, so today's partial day is only reflected
 * once the nightly heal has run — a same-day default returns whatever completed rows exist.
 *
 * Authorized like provenance-daily (the read-only dashboard data path): a handled area uses the
 * share-token-aware `requireDashboardAccess`; an unhandled area falls back to owner/admin/cron.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  if (!planetscaleDb)
    return NextResponse.json({ error: "DB not configured" }, { status: 503 });
  const db = planetscaleDb;

  const { areaId } = await params;
  const [area] = await db
    .select({
      ownerClerkUserId: areas.ownerClerkUserId,
      legacySystemId: areas.legacySystemId,
      tz: areas.timezoneOffsetMin,
    })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!area)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  // Handled area → the shared dashboard-data gate (share-token aware); unhandled → owner/admin/cron.
  if (area.legacySystemId != null) {
    const authResult = await requireDashboardAccess(
      request,
      area.legacySystemId,
    );
    if (authResult instanceof NextResponse) return authResult;
  } else {
    const auth = await getAuthContext(request);
    if (!auth.userId && !auth.isCron)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const isOwner = !!auth.userId && area.ownerClerkUserId === auth.userId;
    if (!auth.isCron && !auth.isAdmin && !isOwner)
      return NextResponse.json(
        { error: "Forbidden — area owner, admin, or cron only" },
        { status: 403 },
      );
  }

  // Resolve [start, end] as local days in the area's timezone (default: today so far).
  const { searchParams } = new URL(request.url);
  let end = getTodayInTimezone(area.tz);
  let start: CalendarDate = end;
  try {
    const endStr = searchParams.get("end");
    const lastStr = searchParams.get("last");
    const startStr = searchParams.get("start");
    if (endStr) end = parseDate(endStr);
    if (lastStr) {
      const n = parseInt(lastStr.replace("d", ""), 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("bad last");
      start = end.subtract({ days: n - 1 });
    } else if (startStr) {
      start = parseDate(startStr);
    } else {
      start = end; // today so far
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid date params (start/end/last — YYYY-MM-DD / 'Nd')" },
      { status: 400 },
    );
  }
  if (start.compare(LIVEONE_BIRTHDATE) < 0) start = LIVEONE_BIRTHDATE;
  if (start.compare(end) > 0)
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 },
    );
  const startDay = start.toString();
  const endDay = end.toString();

  // Per-edge aggregates over the window (summed across days). The FILTER clauses keep the known-value
  // sums; the NULL count on self_renewable_kwh is the partial-data signal metrics 1-2 read.
  const res = await db.execute(sql`
    SELECT
      source_path,
      load_path,
      SUM(energy_kwh)                                            AS energy_kwh,
      SUM(renewable_kwh)      FILTER (WHERE renewable_kwh      IS NOT NULL) AS renewable_kwh,
      SUM(self_renewable_kwh) FILTER (WHERE self_renewable_kwh IS NOT NULL) AS self_renewable_kwh,
      COUNT(*)                FILTER (WHERE self_renewable_kwh  IS NULL)     AS self_renewable_null_rows,
      SUM(estimated_kwh)                                         AS estimated_kwh
    FROM point_readings_flow_attr_1d
    WHERE area_id = ${areaId} AND day >= ${startDay} AND day <= ${endDay}
    GROUP BY source_path, load_path
  `);

  const edges: RenewablesEdgeAgg[] = (res.rows ?? []).map((row) => {
    const r = row as {
      source_path: string;
      load_path: string;
      energy_kwh: number | string | null;
      renewable_kwh: number | string | null;
      self_renewable_kwh: number | string | null;
      self_renewable_null_rows: number | string | null;
      estimated_kwh: number | string | null;
    };
    return {
      sourcePath: r.source_path,
      loadPath: r.load_path,
      energyKwh: Number(r.energy_kwh ?? 0),
      renewableKwh: Number(r.renewable_kwh ?? 0),
      selfRenewableKwh: Number(r.self_renewable_kwh ?? 0),
      selfRenewableNullRows: Number(r.self_renewable_null_rows ?? 0),
      estimatedKwh: Number(r.estimated_kwh ?? 0),
    };
  });

  const computed = computeRenewablesMetrics(edges);

  // Generator note (tooltip): only shown when the area actually has a backup/off-grid generator.
  // Best-effort — a resolution hiccup defaults to false (no note), never fails the summary.
  let hasGenerator = false;
  if (area.legacySystemId != null) {
    try {
      const caps = await capabilitiesForSystem(area.legacySystemId);
      hasGenerator = caps.has("generator-running");
    } catch {
      hasGenerator = false;
    }
  }

  const body: RenewablesSummaryResponse = {
    ok: true,
    areaId,
    systemId: area.legacySystemId,
    range: { start: startDay, end: endDay },
    metrics: computed.metrics,
    consumptionKwh: computed.consumptionKwh,
    selfRenewGeneratedKwh: computed.selfRenewGeneratedKwh,
    estimatedKwh: computed.estimatedKwh,
    pctEstimated: computed.pctEstimated,
    hasGenerator,
  };
  return NextResponse.json(body);
}
