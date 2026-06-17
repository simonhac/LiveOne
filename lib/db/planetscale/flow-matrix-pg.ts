/**
 * Postgres-side energy-flow matrix recompute (behind `FLOW_MATRIX_COMPUTE_IN_PG`).
 *
 * Materializes the per-local-day directional source→load energy matrix into
 * `point_readings_flow_1d` from PG `point_readings_agg_5m`. Built FROM 5m (signed `avg` per
 * point) because that's where direction survives — `agg_1d.avg` cancels charge/discharge and
 * import/export. A multi-day range is then a plain `SUM(energy_kwh) GROUP BY (source_path,
 * load_path)`, since per-interval energy is additive. See docs/architecture/energy-flow-matrix.md.
 *
 * Driven by a LOGICAL SYSTEM (`lib/aggregation/logical-system.ts`) — the role→point mapping — so a
 * single physical system and a composite are handled identically: the recompute reads `agg_5m` for
 * the logical system's point refs (which may span *child* systems for a composite) and writes the
 * resulting matrix under the logical system's Area. Provenance is collapsed into that Area (matching
 * the live dashboard's composite stitching); a flow row's `area_id` is the VIEW the flows belong to.
 *
 * The series assembly (battery/grid split, solar leaf/residual, rest-of-house) and the integration
 * math live in the shared, db-free modules `lib/aggregation/flow-series.ts` and
 * `lib/aggregation/flow-matrix-core.ts`, so this recompute and the live browser / history paths
 * produce identical values by construction.
 *
 * Each day's recompute fully replaces that day's rows (delete + insert in one transaction) so a
 * flow that drops below threshold between runs doesn't linger. Idempotent and order-independent
 * at the day grain; late/out-of-order 5m corrections heal on the next recompute of the day.
 */

import { and, eq, gte, lte, asc, or } from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { planetscaleDb } from "./index";
import { pointReadingsAgg5m, pointReadingsFlow1d } from "./schema";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import { computeFlowMatrix } from "@/lib/aggregation/flow-matrix-core";
import {
  buildFlowSeries,
  applyPowerTransform,
  ClassifiedPoint,
} from "@/lib/aggregation/flow-series";
import type { LogicalSystem } from "@/lib/aggregation/logical-system";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Algorithm version stamped on every row; bump when the math changes so a backfill can detect stale rows. */
export const FLOW_MATRIX_VERSION = 1;

/** Flows below this (kWh) are dropped to keep the table sparse and free of integration noise. */
const MIN_FLOW_KWH = 0.001;

/** Convert an aggregate value to kW given the point's metric unit (W/Wh → /1000). */
function toKw(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "W" || unit === "Wh" ? value / 1000 : value;
}

/**
 * Recompute a logical system's energy-flow matrix for one local day from PG `agg_5m` and replace
 * that day's rows in `point_readings_flow_1d`. Uses the same local-day boundary as the 1d recompute
 * (`dayToUnixRangeForAggregation`) so flow days tile identically with `agg_1d`. The matrix is keyed
 * by — and written under — `logicalSystem.areaId`, while the points read may belong to child systems.
 */
export async function recomputeFlowMatrixForDay(
  db: PgDb,
  logicalSystem: LogicalSystem,
  day: CalendarDate,
): Promise<{ rowsUpserted: number }> {
  const [dayStartUnix, dayEndUnix] = dayToUnixRangeForAggregation(
    day,
    logicalSystem.timezoneOffsetMin,
  );
  const dayStartMs = dayStartUnix * 1000;
  const dayEndMs = dayEndUnix * 1000;
  const dayStr = day.toString();

  // P3 tail-1 (Phase B): point_readings_flow_1d is keyed solely by the view's Area. `areaId` is
  // always present (resolveLogicalSystem skips Area-less systems) and is the table's primary key.
  // See docs/deferred/areas-p3-tail-and-p4-plan.md.
  const dayFilter = and(
    eq(pointReadingsFlow1d.areaId, logicalSystem.areaId),
    eq(pointReadingsFlow1d.day, dayStr),
  );

  const clearDay = () => db.delete(pointReadingsFlow1d).where(dayFilter);

  if (logicalSystem.points.length === 0) {
    await clearDay();
    return { rowsUpserted: 0 };
  }

  // The day's 5m averages for this logical system's point refs (may span child systems).
  const refConds = logicalSystem.points.map((p) =>
    and(
      eq(pointReadingsAgg5m.systemId, p.ref.systemId),
      eq(pointReadingsAgg5m.pointId, p.ref.pointId),
    ),
  );
  const rows = await db
    .select({
      systemId: pointReadingsAgg5m.systemId,
      pointId: pointReadingsAgg5m.pointId,
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      avg: pointReadingsAgg5m.avg,
    })
    .from(pointReadingsAgg5m)
    .where(
      and(
        or(...refConds),
        gte(pointReadingsAgg5m.intervalEnd, new Date(dayStartMs)),
        lte(pointReadingsAgg5m.intervalEnd, new Date(dayEndMs)),
      ),
    )
    .orderBy(asc(pointReadingsAgg5m.intervalEnd));

  if (rows.length === 0) {
    await clearDay();
    return { rowsUpserted: 0 };
  }

  // Dense shared timeline, and each point's signed kW series aligned to it (keyed by system.point
  // since a composite's points span systems).
  const timestamps = [
    ...new Set(rows.map((r) => r.intervalEnd.getTime())),
  ].sort((a, b) => a - b);
  const tIndex = new Map<number, number>(timestamps.map((t, i) => [t, i]));

  const avgByPoint = new Map<string, Map<number, number | null>>();
  for (const r of rows) {
    const key = `${r.systemId}.${r.pointId}`;
    let series = avgByPoint.get(key);
    if (!series) {
      series = new Map();
      avgByPoint.set(key, series);
    }
    series.set(r.intervalEnd.getTime(), r.avg);
  }

  const classified: ClassifiedPoint[] = [];
  for (const p of logicalSystem.points) {
    const series = avgByPoint.get(`${p.ref.systemId}.${p.ref.pointId}`);
    if (!series) continue;
    const power = new Array<number | null>(timestamps.length).fill(null);
    for (const [t, v] of series) {
      const i = tIndex.get(t);
      if (i !== undefined)
        power[i] = applyPowerTransform(toKw(v, p.metricUnit), p.transform);
    }
    classified.push({ stem: p.stem, power });
  }

  const { sources, loads } = buildFlowSeries(classified);
  if (sources.length === 0 || loads.length === 0) {
    await clearDay();
    return { rowsUpserted: 0 };
  }

  const result = computeFlowMatrix({ timestamps, sources, loads });

  const flowRows: (typeof pointReadingsFlow1d.$inferInsert)[] = [];
  for (let s = 0; s < result.sources.length; s++) {
    for (let l = 0; l < result.loads.length; l++) {
      const energyKwh = result.matrix[s][l];
      if (energyKwh > MIN_FLOW_KWH) {
        flowRows.push({
          // point_readings_flow_1d is keyed by the view's Area (P3-tail-1). Identity Areas are
          // 1:1 wrappers, so rows are byte-identical to the old system_id keying — never a recompute.
          areaId: logicalSystem.areaId,
          day: dayStr,
          sourcePath: result.sources[s],
          loadPath: result.loads[l],
          energyKwh,
          sampleCount: result.intervalsUsed,
          version: FLOW_MATRIX_VERSION,
        });
      }
    }
  }

  // Replace the day's rows atomically so dropped flows don't linger.
  await db.transaction(async (tx) => {
    await tx.delete(pointReadingsFlow1d).where(dayFilter);
    if (flowRows.length > 0) {
      await tx.insert(pointReadingsFlow1d).values(flowRows);
    }
  });

  return { rowsUpserted: flowRows.length };
}

/**
 * Daily-cron hook: recompute a logical system/day's flow matrix in PG. Best-effort — no-op if PG
 * isn't configured, and swallows/logs errors so it can never break the daily aggregation it follows.
 */
export async function recomputeFlowMatrixForDayBestEffort(
  logicalSystem: LogicalSystem,
  day: CalendarDate,
): Promise<void> {
  if (!planetscaleDb) return;
  try {
    const { rowsUpserted } = await recomputeFlowMatrixForDay(
      planetscaleDb,
      logicalSystem,
      day,
    );
    console.log(
      `[PG-Flow1d] system=${logicalSystem.id} day=${day.toString()} rows=${rowsUpserted}`,
    );
  } catch (err) {
    console.error(
      `[PG-Flow1d] recompute failed for system=${logicalSystem.id} day=${day.toString()}:`,
      err,
    );
  }
}
