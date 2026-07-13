import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import { getAuthContext } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import { getYesterdayInTimezone } from "@/lib/date-utils";
import { labelForFlowPath } from "@/lib/aggregation/flow-node-meta";
import {
  getFlowConsistency,
  FlowConsistency,
} from "@/lib/db/planetscale/flow-consistency";

export const maxDuration = 30;

const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

/**
 * GET /api/areas/[areaId]/provenance-summary?start=&end=&last= — the verify half of activating or
 * repricing an Area's battery provenance. Pairs with POST .../recompute-provenance (materialise) so
 * activate-then-verify is two calls. Returns:
 *
 *   - `sources[]`: per-source intensities over the window from `point_readings_flow_attr_1d` —
 *     `{ sourcePath, label, energyKwh, kgCo2, avgGramsPerKwh, avgCentsPerKwh, pctRenewable,
 *        pctEstimated }`. Averages use FILTERED (known-intensity) denominators so estimated/unknown
 *     edges don't bias g/kWh, c/kWh, or %renewable — same math as reduceLoadProvenance, per source.
 *     A generator reprice is verified here (e.g. `source.grid` → ~1000 g/kWh).
 *   - `consistency`: the legacy↔modern reconciliation ({@link FlowConsistency}) — `deltaKwh`,
 *     per-side day coverage, and the divergent days. delta 0 + no divergent days == the rollup is a
 *     faithful projection of the Sankey.
 *
 * Range defaults to the LiveOne birthdate → yesterday (full history); `last` ("Nd") or `start`+`end`
 * override. Authorized for the area's **owner**, an **admin**, or a **`CRON_SECRET` bearer** (headless
 * ops), matching the sibling recompute endpoints. Query params, so it's a cache-friendly GET.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const auth = await getAuthContext(request);
  if (!auth.userId && !auth.isCron)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const isOwner = !!auth.userId && area.ownerClerkUserId === auth.userId;
  if (!auth.isCron && !auth.isAdmin && !isOwner)
    return NextResponse.json(
      { error: "Forbidden — area owner, admin, or cron only" },
      { status: 403 },
    );

  // Resolve [start, end] as local days in the area's timezone (mirrors recompute-provenance).
  const { searchParams } = new URL(request.url);
  let end = getYesterdayInTimezone(area.tz);
  let start: CalendarDate;
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
      start = LIVEONE_BIRTHDATE; // full history
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

  // Per-source intensities from the modern rollup. FILTER (WHERE metric IS NOT NULL) keeps the
  // known-intensity denominator separate so unknown/estimated edges don't bias the averages.
  const res = await db.execute(sql`
    SELECT
      source_path,
      SUM(energy_kwh)                                          AS energy_kwh,
      SUM(estimated_kwh)                                       AS estimated_kwh,
      SUM(emissions_g)  FILTER (WHERE emissions_g  IS NOT NULL) AS emissions_g,
      SUM(energy_kwh)   FILTER (WHERE emissions_g  IS NOT NULL) AS emissions_known_kwh,
      SUM(renewable_kwh) FILTER (WHERE renewable_kwh IS NOT NULL) AS renewable_kwh,
      SUM(energy_kwh)    FILTER (WHERE renewable_kwh IS NOT NULL) AS renewable_known_kwh,
      SUM(cost_c)       FILTER (WHERE cost_c IS NOT NULL)        AS cost_c,
      SUM(energy_kwh)   FILTER (WHERE cost_c IS NOT NULL)        AS cost_known_kwh
    FROM point_readings_flow_attr_1d
    WHERE area_id = ${areaId} AND day >= ${startDay} AND day <= ${endDay}
    GROUP BY source_path
    ORDER BY SUM(energy_kwh) DESC
  `);

  const emptyLabels = new Map<string, string>();
  const sources = (res.rows ?? []).map((row) => {
    const r = row as {
      source_path: string;
      energy_kwh: number | string | null;
      estimated_kwh: number | string | null;
      emissions_g: number | string | null;
      emissions_known_kwh: number | string | null;
      renewable_kwh: number | string | null;
      renewable_known_kwh: number | string | null;
      cost_c: number | string | null;
      cost_known_kwh: number | string | null;
    };
    const energyKwh = Number(r.energy_kwh ?? 0);
    const estimatedKwh = Number(r.estimated_kwh ?? 0);
    const emissionsG = r.emissions_g == null ? null : Number(r.emissions_g);
    const emissionsKnownKwh = Number(r.emissions_known_kwh ?? 0);
    const renewableKwh =
      r.renewable_kwh == null ? null : Number(r.renewable_kwh);
    const renewableKnownKwh = Number(r.renewable_known_kwh ?? 0);
    const costC = r.cost_c == null ? null : Number(r.cost_c);
    const costKnownKwh = Number(r.cost_known_kwh ?? 0);
    return {
      sourcePath: r.source_path,
      label: labelForFlowPath(r.source_path, emptyLabels),
      energyKwh,
      kgCo2: emissionsG != null ? emissionsG / 1000 : 0,
      avgGramsPerKwh:
        emissionsG != null && emissionsKnownKwh > 0
          ? emissionsG / emissionsKnownKwh
          : null,
      avgCentsPerKwh:
        costC != null && costKnownKwh > 0 ? costC / costKnownKwh : null,
      pctRenewable:
        renewableKwh != null && renewableKnownKwh > 0
          ? (100 * renewableKwh) / renewableKnownKwh
          : null,
      pctEstimated: energyKwh > 0 ? (100 * estimatedKwh) / energyKwh : 0,
    };
  });

  // legacy↔modern reconciliation over the same window (shared with the monitor consistency alert).
  const consistency: FlowConsistency = (
    await getFlowConsistency(db, { areaId, startDay, endDay })
  )[0] ?? {
    areaId,
    legacyKwh: 0,
    modernKwh: 0,
    deltaKwh: 0,
    legacyDays: 0,
    modernDays: 0,
    divergentDays: [],
  };

  return NextResponse.json({
    ok: true,
    areaId,
    systemId: area.legacySystemId,
    range: { start: startDay, end: endDay },
    sources,
    consistency,
  });
}
