import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import { getAuthContext, requireDashboardAccess } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas, batteryProvenanceDaily } from "@/lib/db/planetscale/schema";
import { getYesterdayInTimezone } from "@/lib/date-utils";
import { validateFoldCheckpointEnvelope } from "@/lib/battery-provenance/checkpoint";
import {
  PROVENANCE_FIELD_KEYS,
  PLOTTABLE_ROW_KEYS,
  type ProvenanceDailyResponse,
  type ProvenanceFieldKey,
} from "@/lib/battery-provenance/field-registry";

export const maxDuration = 30;

const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

/** Payload bound: at most this many calendar days (= rows) per response. */
const MAX_SPAN_DAYS = 400;

/**
 * GET /api/areas/[areaId]/provenance-daily?start=&end=&last= — the history panel's read path over
 * `battery_provenance_daily`. Returns {@link ProvenanceDailyResponse}: a DENSE columnar payload —
 * `days` is the full calendar sequence start..end (area-local YYYY-MM-DD) and every `fields[key]`
 * array is parallel to it, with absent DB rows null at that index in EVERY field. `recal`
 * serializes as 0|1; the six `fold*` scalars come from the row's validated fold checkpoint
 * envelope (all six null when the envelope is absent/invalid).
 *
 * Range defaults to the trailing year ending yesterday in the area's timezone (today's row can be
 * a checkpoint-only partial); `last` ("Nd") or `start`+`end` override. Start is clamped to the
 * LiveOne birthdate and the span is capped at {@link MAX_SPAN_DAYS} days (start clamped up).
 * Authorized like the other dashboard data routes: when the area has an integer handle,
 * `requireDashboardAccess` (owner/admin/viewer/public or a per-dashboard share token); otherwise
 * the provenance-summary owner/admin/cron gate.
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

  // Resolve [start, end] as local days in the area's timezone (mirrors provenance-summary; the
  // default window is the trailing year ending yesterday).
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
      start = end.subtract({ days: 364 }); // trailing year
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid date params (start/end/last — YYYY-MM-DD / 'Nd')" },
      { status: 400 },
    );
  }
  // A genuinely malformed request (the caller's own start is after its own end) is a 400. This
  // check must run BEFORE the birthdate clamp below — clamping a valid, merely-early `start` up to
  // LIVEONE_BIRTHDATE can itself push it past `end` (a historical window requested entirely before
  // the site existed, e.g. paging "older" back past day one) — that's an empty result, not an error.
  if (start.compare(end) > 0)
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 },
    );
  if (start.compare(LIVEONE_BIRTHDATE) < 0) start = LIVEONE_BIRTHDATE;
  if (start.compare(end) > 0) {
    const body: ProvenanceDailyResponse = {
      areaId,
      systemId: area.legacySystemId,
      range: { start: start.toString(), end: end.toString() },
      days: [],
      fields: Object.fromEntries(
        PROVENANCE_FIELD_KEYS.map((k) => [k, [] as (number | null)[]]),
      ) as Record<ProvenanceFieldKey, (number | null)[]>,
      rowMeta: { firstIntervalEnd: [], version: [], updatedAt: [] },
    };
    return NextResponse.json(body);
  }
  // Cap the span to bound the payload — clamp start UP when a wider window was requested.
  const maxSpanStart = end.subtract({ days: MAX_SPAN_DAYS - 1 });
  if (start.compare(maxSpanStart) < 0) start = maxSpanStart;
  const startDay = start.toString();
  const endDay = end.toString();

  const rows = await db
    .select()
    .from(batteryProvenanceDaily)
    .where(
      and(
        eq(batteryProvenanceDaily.areaId, areaId),
        gte(batteryProvenanceDaily.day, startDay),
        lte(batteryProvenanceDaily.day, endDay),
      ),
    )
    .orderBy(asc(batteryProvenanceDaily.day));
  const byDay = new Map(rows.map((r) => [r.day, r]));

  // Dense columnar build: one push into EVERY array per calendar day, so all arrays stay parallel.
  const days: string[] = [];
  const fields = Object.fromEntries(
    PROVENANCE_FIELD_KEYS.map((k) => [k, [] as (number | null)[]]),
  ) as Record<ProvenanceFieldKey, (number | null)[]>;
  const firstIntervalEnd: (string | null)[] = [];
  const version: (number | null)[] = [];
  const updatedAt: (string | null)[] = [];

  for (let d = start; d.compare(end) <= 0; d = d.add({ days: 1 })) {
    const day = d.toString();
    days.push(day);
    const row = byDay.get(day);
    if (!row) {
      for (const k of PROVENANCE_FIELD_KEYS) fields[k].push(null);
      firstIntervalEnd.push(null);
      version.push(null);
      updatedAt.push(null);
      continue;
    }
    for (const k of PLOTTABLE_ROW_KEYS) {
      const raw = row[k];
      const num = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
      fields[k].push(
        typeof num === "number" && Number.isFinite(num) ? num : null,
      );
    }
    const env = validateFoldCheckpointEnvelope(row.foldState);
    fields.foldStoredKwh.push(env ? env.state.storedKwh : null);
    fields.foldEstimatedKwh.push(env ? env.state.estimatedKwh : null);
    fields.foldRenewableKwh.push(env ? env.state.renewableKwh : null);
    fields.foldCarbonG.push(env ? env.state.carbonG : null);
    fields.foldCostC.push(env ? env.state.costC : null);
    fields.foldForgoneC.push(env ? env.state.forgoneC : null);
    firstIntervalEnd.push(row.firstIntervalEnd?.toISOString() ?? null);
    version.push(row.version);
    updatedAt.push(row.updatedAt?.toISOString() ?? null);
  }

  const body: ProvenanceDailyResponse = {
    areaId,
    systemId: area.legacySystemId,
    range: { start: startDay, end: endDay },
    days,
    fields,
    rowMeta: { firstIntervalEnd, version, updatedAt },
  };
  return NextResponse.json(body);
}
