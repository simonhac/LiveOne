/**
 * Postgres side of the admin readings shadows (PR-12): the point-readings pivot and the
 * single-point window views. These mirror the Turso raw-SQL the admin routes run today, with the
 * ms↔timestamp translation Postgres needs, and return rows shaped so the routes' existing JS
 * transforms are unchanged.
 *
 * Time keys: Turso stores epoch-ms integers; PG stores native `timestamp` (UTC). Where the route's
 * transform consumes an epoch-ms `measurement_time`, these queries project
 * `EXTRACT(EPOCH FROM col AT TIME ZONE 'UTC') * 1000` so the value is epoch-ms regardless of the
 * Node process timezone — keeping the values aligned even outside a TZ=UTC runtime.
 *
 * These are the served PG read for the admin point-readings views; callers run them under
 * `serveReadings`, which falls back to Turso on any error.
 */
import { sql } from "drizzle-orm";
import { planetscaleDb } from "./index";
import {
  SHADOW_SKIP,
  pairMatches,
  type ReadingsCompareResult,
} from "@/lib/db/readings-serve";

type Row = Record<string, unknown>;

async function runRawPg(query: string): Promise<Row[]> {
  const res = await planetscaleDb!.execute(sql.raw(query));
  return ((res as { rows?: Row[] }).rows ?? []) as Row[];
}

export interface AdminPivotParams {
  systemId: number;
  source: string; // "raw" | "5m" | "daily"
  cursor: number | string | null;
  direction: string; // "older" | "newer"
  limit: number;
  /**
   * The dialect-agnostic pivot column expressions, built once by the route (e.g.
   * `MAX(CASE WHEN pr.system_id = 1 AND pr.point_id = 0 THEN pr.value END) as point_0`). The same
   * column names exist in the PG schema, so the expressions are reused verbatim.
   */
  pivotColumns: string;
}

/**
 * Run the admin point-readings pivot against Postgres, mirroring the Turso pivot in
 * `app/api/admin/systems/[systemId]/point-readings/route.ts`. Returns `SHADOW_SKIP` when PG is
 * unconfigured. `measurement_time` comes back as epoch-ms (raw/5m) or a YYYY-MM-DD string (daily),
 * matching what the route's transform expects.
 */
export async function fetchAdminPivotRowsPg(
  p: AdminPivotParams,
): Promise<Row[] | typeof SHADOW_SKIP> {
  if (!planetscaleDb) return SHADOW_SKIP;
  const { systemId, source, cursor, direction, limit, pivotColumns } = p;

  if (source === "daily") {
    const cursorFilter = cursor
      ? direction === "older"
        ? `AND day < '${cursor}'`
        : `AND day > '${cursor}'`
      : "";
    const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";
    return runRawPg(`
      WITH recent_days AS (
        SELECT DISTINCT day
        FROM point_readings_agg_1d pr
        INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
        WHERE pi.system_id = ${systemId}
        ${cursorFilter}
        ORDER BY day ${orderDirection}
        LIMIT ${limit}
      )
      SELECT
        pr.day as measurement_time,
        NULL as session_id,
        NULL as session_label,
        ${pivotColumns}
      FROM point_readings_agg_1d pr
      WHERE pr.system_id = ${systemId}
        AND pr.day IN (SELECT day FROM recent_days)
      GROUP BY pr.day
      ORDER BY pr.day DESC
    `);
  }

  // raw / 5m share the timestamp shape; only the table + time column differ.
  const table = source === "5m" ? "point_readings_agg_5m" : "point_readings";
  const timeCol = source === "5m" ? "interval_end" : "measurement_time";
  const tsCursor =
    cursor != null ? `to_timestamp(${Number(cursor)} / 1000.0)` : null;
  const cursorFilter = tsCursor
    ? direction === "older"
      ? `AND ${timeCol} < ${tsCursor}`
      : `AND ${timeCol} > ${tsCursor}`
    : "";
  const orderDirection = direction === "newer" && cursor ? "ASC" : "DESC";

  return runRawPg(`
    WITH recent_timestamps AS (
      SELECT DISTINCT ${timeCol}
      FROM ${table} pr
      INNER JOIN point_info pi ON pr.system_id = pi.system_id AND pr.point_id = pi.id
      WHERE pi.system_id = ${systemId}
      ${cursorFilter}
      ORDER BY ${timeCol} ${orderDirection}
      LIMIT ${limit}
    )
    SELECT
      (EXTRACT(EPOCH FROM pr.${timeCol} AT TIME ZONE 'UTC') * 1000) as measurement_time,
      pr.session_id,
      s.session_label,
      ${pivotColumns}
    FROM ${table} pr
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE pr.system_id = ${systemId}
      AND pr.${timeCol} IN (SELECT ${timeCol} FROM recent_timestamps)
    GROUP BY pr.${timeCol}, pr.session_id, s.session_label
    ORDER BY pr.${timeCol} DESC, pr.session_id
  `);
}

/**
 * Compare the transformed admin-pivot `data[]` from Turso vs Postgres. Rows are matched by their
 * time/date + sessionId key; the `point_*` value cells are compared with `pairMatches` (numeric
 * tolerance, null/presence-only lenient — so live-tail lag and the sliding LIMIT window at the
 * page boundary never register as a hard divergence). Reports up to the first 10 cell diffs.
 */
export function comparePivotData(
  turso: Row[],
  pg: Row[],
): ReadingsCompareResult {
  const keyOf = (r: Row) =>
    `${(r.time ?? r.date ?? "") as string}|${(r.sessionId ?? "") as string}`;
  const pByKey = new Map(pg.map((r) => [keyOf(r), r]));
  const diffs: string[] = [];

  for (const t of turso) {
    const p = pByKey.get(keyOf(t));
    if (!p) continue; // present only on Turso (tail / page boundary) — not a divergence
    for (const field of Object.keys(t)) {
      if (!field.startsWith("point_")) continue;
      if (!pairMatches(t[field], p[field])) {
        diffs.push(`${keyOf(t)} ${field}: turso=${t[field]} pg=${p[field]}`);
      }
    }
  }

  if (diffs.length === 0) return { matched: true };
  return {
    matched: false,
    detail: `rows=${turso.length}/${pg.length} ${diffs.slice(0, 10).join("; ")}`,
  };
}

// ============================================================================
// Single-point readings window (admin/point/[systemIdDotPointId]/readings)
// ============================================================================

export interface SinglePointParams {
  systemId: number;
  pointId: number;
  source: string; // "raw" | "5m" | "daily"
  timestamp: number | null; // epoch-ms (raw/5m)
  startDayStr?: string; // 1d window (YYYY-MM-DD-ish, mirrors the Turso route exactly)
  endDayStr?: string;
}

/** A `timestamp without time zone` literal (UTC) for an epoch-ms value — TZ-independent. */
function tsLitUTC(ms: number): string {
  return `(to_timestamp(${Number(ms)} / 1000.0) AT TIME ZONE 'UTC')`;
}

/**
 * Mirror of the admin single-point window queries (raw ±1h / 5m ROW_NUMBER ±10 / daily ±9d) against
 * Postgres. camelCase aliases are double-quoted (PG folds unquoted identifiers to lowercase) and
 * the `measurement_time`/`interval_end`/`received_time` columns are projected back to epoch-ms so
 * the route's centering (`r.intervalEnd === timestamp`) and the comparator match Turso's shape.
 */
export async function fetchSinglePointReadingsPg(
  p: SinglePointParams,
): Promise<Row[] | typeof SHADOW_SKIP> {
  if (!planetscaleDb) return SHADOW_SKIP;
  const { systemId, pointId, source, timestamp } = p;

  if (source === "daily") {
    return runRawPg(`
      SELECT
        pr.system_id as "systemId",
        pr.point_id as "pointId",
        pr.day as date,
        pr.avg,
        pr.min,
        pr.max,
        pr.last,
        pr.delta,
        pr.sample_count as "sampleCount",
        pr.error_count as "errorCount"
      FROM point_readings_agg_1d pr
      WHERE pr.system_id = ${systemId}
        AND pr.point_id = ${pointId}
        AND pr.day >= '${p.startDayStr}'
        AND pr.day <= '${p.endDayStr}'
      ORDER BY pr.day ASC
    `);
  }

  if (source === "5m") {
    return runRawPg(`
      WITH all_rows AS (
        SELECT interval_end, ROW_NUMBER() OVER (ORDER BY interval_end ASC) as row_num
        FROM point_readings_agg_5m
        WHERE system_id = ${systemId} AND point_id = ${pointId}
      ),
      target_position AS (
        SELECT row_num as target_row FROM all_rows
        WHERE interval_end = ${tsLitUTC(timestamp!)}
      ),
      ranked AS (
        SELECT
          pr.system_id as "systemId",
          pr.point_id as "pointId",
          pr.session_id as "sessionId",
          (EXTRACT(EPOCH FROM pr.interval_end AT TIME ZONE 'UTC') * 1000) as "intervalEnd",
          pr.avg,
          pr.min,
          pr.max,
          pr.last,
          pr.delta,
          pr.sample_count as "sampleCount",
          pr.error_count as "errorCount",
          pr.data_quality as "dataQuality",
          s.session_label as "sessionLabel",
          ROW_NUMBER() OVER (ORDER BY pr.interval_end ASC) as row_num
        FROM point_readings_agg_5m pr
        LEFT JOIN sessions s ON pr.session_id = s.id
        WHERE pr.system_id = ${systemId} AND pr.point_id = ${pointId}
      )
      SELECT ranked.* FROM ranked, target_position
      WHERE ranked.row_num BETWEEN (target_position.target_row - 10) AND (target_position.target_row + 10)
      ORDER BY "intervalEnd" ASC
    `);
  }

  // raw: ±1 hour window around the target timestamp.
  const oneHour = 60 * 60 * 1000;
  const startTime = timestamp! - oneHour;
  const endTime = timestamp! + oneHour;
  return runRawPg(`
    SELECT
      pr.id,
      pr.system_id as "systemId",
      pr.point_id as "pointId",
      pr.session_id as "sessionId",
      (EXTRACT(EPOCH FROM pr.measurement_time AT TIME ZONE 'UTC') * 1000) as "measurementTime",
      (EXTRACT(EPOCH FROM pr.received_time AT TIME ZONE 'UTC') * 1000) as "receivedTime",
      pr.value,
      pr.value_str as "valueStr",
      pr.error,
      pr.data_quality as "dataQuality",
      s.session_label as "sessionLabel"
    FROM point_readings pr
    LEFT JOIN sessions s ON pr.session_id = s.id
    WHERE pr.system_id = ${systemId}
      AND pr.point_id = ${pointId}
      AND pr.measurement_time >= ${tsLitUTC(startTime)}
      AND pr.measurement_time <= ${tsLitUTC(endTime)}
    ORDER BY pr.measurement_time ASC
  `);
}

/**
 * Compare the single-point window rows from Turso vs Postgres. Rows are keyed by their time field
 * (date / intervalEnd / measurementTime); value fields use the reconciler's value set for aggregates
 * and value/valueStr for raw, all via `pairMatches` (numeric tolerance, presence-only lenient).
 */
export function compareSinglePoint(
  turso: Row[],
  pg: Row[],
  source: string,
): ReadingsCompareResult {
  const keyField =
    source === "daily"
      ? "date"
      : source === "5m"
        ? "intervalEnd"
        : "measurementTime";
  const valueFields =
    source === "raw"
      ? ["value", "valueStr"]
      : ["avg", "min", "max", "last", "delta", "sampleCount", "errorCount"];

  const pByKey = new Map(pg.map((r) => [String(r[keyField]), r]));
  const diffs: string[] = [];
  for (const t of turso) {
    const p = pByKey.get(String(t[keyField]));
    if (!p) continue; // present only on Turso (tail / window boundary) — not a divergence
    for (const f of valueFields) {
      if (!pairMatches(t[f], p[f])) {
        diffs.push(`${String(t[keyField])} ${f}: turso=${t[f]} pg=${p[f]}`);
      }
    }
  }

  if (diffs.length === 0) return { matched: true };
  return {
    matched: false,
    detail: `n=${turso.length}/${pg.length} ${diffs.slice(0, 10).join("; ")}`,
  };
}
