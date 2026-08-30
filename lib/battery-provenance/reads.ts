/**
 * The two battery-provenance READ computations, lifted out of the route layer so the
 * `/api/v4/areas/{ar_…}/provenance-{daily,summary}` handlers are auth + wiring only. Both routes
 * import from here; there is one implementation of each read.
 *
 * The window resolver is shared by both reads, including the one asymmetry between them:
 * `provenance-daily` defaults to the trailing year ending yesterday, `provenance-summary` to full
 * history from the LiveOne birthdate.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { parseDate, CalendarDate } from "@internationalized/date";
import type { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { batteryProvenanceDaily } from "@/lib/db/planetscale/schema";
import { getYesterdayInTimezone } from "@/lib/date-utils";
import { validateFoldCheckpointEnvelope } from "@/lib/battery-provenance/checkpoint";
import { labelForFlowPath } from "@/lib/aggregation/flow-node-meta";
import {
  PROVENANCE_FIELD_KEYS,
  PLOTTABLE_ROW_KEYS,
  type ProvenanceDailyResponse,
  type ProvenanceFieldKey,
} from "@/lib/battery-provenance/field-registry";
import { Area } from "@/lib/ids";

/** The concrete drizzle handle both reads take — the same type every route already holds. */
type PlanetscaleDb = ReturnType<typeof requirePlanetscaleDb>;

/** The first day LiveOne held any data — every window is clamped up to this. */
export const LIVEONE_BIRTHDATE = new CalendarDate(2025, 8, 16);

/** Payload bound for `provenance-daily`: at most this many calendar days (= rows) per response. */
export const MAX_SPAN_DAYS = 400;

export type DayWindow = { start: CalendarDate; end: CalendarDate };

export type WindowResult =
  | { ok: true; window: DayWindow }
  | { ok: false; error: string };

/**
 * Resolve `?start=&end=&last=` into a `[start, end]` pair of LOCAL days in the area's timezone.
 *
 * `defaultStart` is the only difference between the two reads: `"trailing-year"` (daily) or
 * `"birthdate"` (summary). The birthdate clamp runs AFTER the caller's own start-after-end check, so a
 * legitimately-early window (paged back past day one) clamps to empty rather than 400ing — see the
 * comment at the call site.
 */
export function resolveDayWindow(
  searchParams: URLSearchParams,
  timezoneOffsetMin: number,
  defaultStart: "trailing-year" | "birthdate",
): WindowResult {
  let end = getYesterdayInTimezone(timezoneOffsetMin);
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
      start =
        defaultStart === "trailing-year"
          ? end.subtract({ days: 364 })
          : LIVEONE_BIRTHDATE;
    }
  } catch {
    return {
      error: "Invalid date params (start/end/last — YYYY-MM-DD / 'Nd')",
      ok: false,
    };
  }
  return { ok: true, window: { start, end } };
}

function emptyFields(): Record<ProvenanceFieldKey, (number | null)[]> {
  return Object.fromEntries(
    PROVENANCE_FIELD_KEYS.map((k) => [k, [] as (number | null)[]]),
  ) as Record<ProvenanceFieldKey, (number | null)[]>;
}

/** The empty (start-after-end) `provenance-daily` payload — a real window, zero days. */
export function emptyProvenanceDaily(
  areaUuid: string,
  legacySystemId: number | null,
  window: DayWindow,
): ProvenanceDailyResponse {
  return {
    areaId: Area.encode(areaUuid),
    systemId: legacySystemId,
    range: { start: window.start.toString(), end: window.end.toString() },
    days: [],
    fields: emptyFields(),
    rowMeta: { firstIntervalEnd: [], version: [], updatedAt: [] },
  };
}

/**
 * The DENSE columnar history payload: `days` is the full calendar sequence start..end and every
 * `fields[key]` array is parallel to it, with absent DB rows null at that index in EVERY field.
 * `recal` serializes as 0|1; the seven `fold*` scalars come from the row's validated fold checkpoint
 * envelope (all null when the envelope is absent/invalid).
 */
export async function readProvenanceDaily(
  db: PlanetscaleDb,
  areaUuid: string,
  legacySystemId: number | null,
  window: DayWindow,
): Promise<ProvenanceDailyResponse> {
  const { start, end } = window;
  const startDay = start.toString();
  const endDay = end.toString();

  const rows = await db
    .select()
    .from(batteryProvenanceDaily)
    .where(
      and(
        eq(batteryProvenanceDaily.areaId, areaUuid),
        gte(batteryProvenanceDaily.day, startDay),
        lte(batteryProvenanceDaily.day, endDay),
      ),
    )
    .orderBy(asc(batteryProvenanceDaily.day));
  const byDay = new Map(rows.map((r) => [r.day, r]));

  // Dense columnar build: one push into EVERY array per calendar day, so all arrays stay parallel.
  const days: string[] = [];
  const fields = emptyFields();
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
    fields.foldSelfRenewableKwh.push(env ? env.state.selfRenewableKwh : null);
    fields.foldCarbonG.push(env ? env.state.carbonG : null);
    fields.foldCostC.push(env ? env.state.costC : null);
    fields.foldForgoneC.push(env ? env.state.forgoneC : null);
    firstIntervalEnd.push(row.firstIntervalEnd?.toISOString() ?? null);
    version.push(row.version);
    updatedAt.push(row.updatedAt?.toISOString() ?? null);
  }

  return {
    areaId: Area.encode(areaUuid),
    systemId: legacySystemId,
    range: { start: startDay, end: endDay },
    days,
    fields,
    rowMeta: { firstIntervalEnd, version, updatedAt },
  };
}

/** One row of `provenance-summary`'s `sources[]` — per-source intensities over the window. */
export interface ProvenanceSummarySource {
  sourcePath: string;
  label: string;
  energyKwh: number;
  kgCo2: number;
  avgGramsPerKwh: number | null;
  avgCentsPerKwh: number | null;
  pctRenewable: number | null;
  pctEstimated: number;
}

/**
 * Per-source intensities from `point_readings_flow_attr_1d`. `FILTER (WHERE metric IS NOT NULL)` keeps
 * the known-intensity denominator separate so unknown/estimated edges don't bias g/kWh, c/kWh or
 * %renewable — the same math as `reduceLoadProvenance`, per source.
 */
export async function readProvenanceSummary(
  db: PlanetscaleDb,
  areaUuid: string,
  window: DayWindow,
): Promise<ProvenanceSummarySource[]> {
  const startDay = window.start.toString();
  const endDay = window.end.toString();

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
    WHERE area_id = ${areaUuid} AND day >= ${startDay} AND day <= ${endDay}
    GROUP BY source_path
    ORDER BY SUM(energy_kwh) DESC
  `);

  const emptyLabels = new Map<string, string>();
  return (res.rows ?? []).map((row) => {
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
}
