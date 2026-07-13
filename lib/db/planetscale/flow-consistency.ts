import { sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Per-day |legacy − modern| below this (kWh) is floating-point noise, not a real divergence. */
export const FLOW_CONSISTENCY_TOL_KWH = 0.05;

/** A single day where the modern rollup and the legacy Sankey disagree on energy. */
export interface FlowConsistencyDay {
  day: string; // YYYY-MM-DD (system-local, same convention as the flow tables)
  legacyKwh: number;
  modernKwh: number;
  diffKwh: number; // legacy − modern
}

/** One Area's legacy↔modern energy reconciliation over a range. */
export interface FlowConsistency {
  areaId: string;
  legacyKwh: number; // Σ point_readings_flow_1d.energy_kwh
  modernKwh: number; // Σ point_readings_flow_attr_1d.energy_kwh
  deltaKwh: number; // legacy − modern
  legacyDays: number; // distinct days present in flow_1d
  modernDays: number; // distinct days present in flow_attr_1d
  divergentDays: FlowConsistencyDay[]; // |legacy − modern| > tol, oldest-first
}

/** One (area, day) row of the FULL OUTER JOIN between the two flow tables' per-day energy sums. */
export interface FlowConsistencyRow {
  areaId: string;
  day: string;
  legacyKwh: number;
  modernKwh: number;
  hasLegacy: boolean; // the day had flow_1d rows
  hasModern: boolean; // the day had flow_attr_1d rows
}

export interface FlowConsistencyOptions {
  areaId?: string; // restrict to one Area (else every Area with flow rows)
  startDay?: string; // YYYY-MM-DD inclusive
  endDay?: string; // YYYY-MM-DD inclusive
  tolKwh?: number; // per-day divergence tolerance (default FLOW_CONSISTENCY_TOL_KWH)
}

/**
 * Pure reduction of per-(area, day) legacy/modern energy rows into a per-Area reconciliation. Kept
 * separate from the query so it can be unit-tested with synthetic on-grid (matching) and off-grid
 * (holed) fixtures without a database.
 */
export function reduceFlowConsistency(
  rows: FlowConsistencyRow[],
  tolKwh: number = FLOW_CONSISTENCY_TOL_KWH,
): FlowConsistency[] {
  const byArea = new Map<string, FlowConsistency>();
  for (const r of rows) {
    let acc = byArea.get(r.areaId);
    if (!acc) {
      acc = {
        areaId: r.areaId,
        legacyKwh: 0,
        modernKwh: 0,
        deltaKwh: 0,
        legacyDays: 0,
        modernDays: 0,
        divergentDays: [],
      };
      byArea.set(r.areaId, acc);
    }
    acc.legacyKwh += r.legacyKwh;
    acc.modernKwh += r.modernKwh;
    if (r.hasLegacy) acc.legacyDays += 1;
    if (r.hasModern) acc.modernDays += 1;
    const diff = r.legacyKwh - r.modernKwh;
    if (Math.abs(diff) > tolKwh) {
      acc.divergentDays.push({
        day: r.day,
        legacyKwh: r.legacyKwh,
        modernKwh: r.modernKwh,
        diffKwh: diff,
      });
    }
  }
  for (const acc of byArea.values()) {
    acc.deltaKwh = acc.legacyKwh - acc.modernKwh;
    acc.divergentDays.sort((a, b) => a.day.localeCompare(b.day));
  }
  return [...byArea.values()];
}

/**
 * Per-Area consistency of the modern provenance rollup (`point_readings_flow_attr_1d`) against the
 * legacy Sankey (`point_readings_flow_1d`). By design the modern energy leg is the energy projection
 * of the SAME accounting as legacy — byte-identical per (area, day) — so any divergence is a
 * materialisation bug or a missed re-backfill (e.g. a single un-healed day sitting silently wrong on
 * the provenance card). One cheap grouped query (both tables are small + indexed on (area_id, day)),
 * reduced per Area in JS.
 *
 * Shared by the monitor-observations consistency alert (all areas, full history) and the
 * provenance-summary endpoint (one area, one range).
 */
export async function getFlowConsistency(
  db: PgDb,
  opts: FlowConsistencyOptions = {},
): Promise<FlowConsistency[]> {
  const conds = [];
  if (opts.areaId) conds.push(sql`area_id = ${opts.areaId}`);
  if (opts.startDay) conds.push(sql`day >= ${opts.startDay}`);
  if (opts.endDay) conds.push(sql`day <= ${opts.endDay}`);
  const where = conds.length
    ? sql`WHERE ${sql.join(conds, sql` AND `)}`
    : sql``;

  const res = await db.execute(sql`
    WITH l AS (
      SELECT area_id, day, SUM(energy_kwh) AS kwh
      FROM point_readings_flow_1d ${where} GROUP BY area_id, day
    ),
    m AS (
      SELECT area_id, day, SUM(energy_kwh) AS kwh
      FROM point_readings_flow_attr_1d ${where} GROUP BY area_id, day
    )
    SELECT
      COALESCE(l.area_id, m.area_id)::text AS area_id,
      COALESCE(l.day, m.day)               AS day,
      COALESCE(l.kwh, 0)                   AS legacy_kwh,
      COALESCE(m.kwh, 0)                   AS modern_kwh,
      (l.day IS NOT NULL)                  AS has_legacy,
      (m.day IS NOT NULL)                  AS has_modern
    FROM l FULL OUTER JOIN m ON l.area_id = m.area_id AND l.day = m.day
    ORDER BY area_id, day
  `);

  const raw = (res.rows ?? []) as {
    area_id: string;
    day: string;
    legacy_kwh: number | string;
    modern_kwh: number | string;
    has_legacy: boolean;
    has_modern: boolean;
  }[];

  return reduceFlowConsistency(
    raw.map((r) => ({
      areaId: r.area_id,
      day: r.day,
      legacyKwh: Number(r.legacy_kwh ?? 0),
      modernKwh: Number(r.modern_kwh ?? 0),
      hasLegacy: !!r.has_legacy,
      hasModern: !!r.has_modern,
    })),
    opts.tolKwh ?? FLOW_CONSISTENCY_TOL_KWH,
  );
}
