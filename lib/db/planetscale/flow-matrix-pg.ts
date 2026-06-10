/**
 * Postgres-side energy-flow matrix recompute (behind `FLOW_MATRIX_COMPUTE_IN_PG`).
 *
 * Materializes the per-local-day directional source→load energy matrix into
 * `point_readings_flow_1d` from PG `point_readings_agg_5m`. Built FROM 5m (signed `avg` per
 * point) because that's where direction survives — `agg_1d.avg` cancels charge/discharge and
 * import/export. A multi-day range is then a plain `SUM(energy_kwh) GROUP BY (source_path,
 * load_path)`, since per-interval energy is additive. See docs/architecture/ENERGY-FLOW-MATRIX.md.
 *
 * The series assembly (battery/grid split, solar leaf/residual, rest-of-house) and the
 * integration math live in the shared, db-free modules `lib/aggregation/flow-series.ts` and
 * `lib/aggregation/flow-matrix-core.ts`, so this recompute and the live browser path produce
 * identical values by construction.
 *
 * Each day's recompute fully replaces that day's rows (delete + insert in one transaction) so a
 * flow that drops below threshold between runs doesn't linger. Idempotent and order-independent
 * at the day grain; late/out-of-order 5m corrections heal on the next recompute of the day.
 */

import { and, eq, gte, lte, asc } from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { planetscaleDb } from "./index";
import { pointReadingsAgg5m, pointReadingsFlow1d, pointInfo } from "./schema";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import { computeFlowMatrix } from "@/lib/aggregation/flow-matrix-core";
import {
  buildFlowSeries,
  ClassifiedPoint,
} from "@/lib/aggregation/flow-series";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Minimal system shape the recompute needs (a Turso/PG `systems` row satisfies it). */
interface SystemForFlow {
  id: number;
  timezoneOffsetMin: number;
}

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
 * Recompute a system/day's energy-flow matrix from PG `agg_5m` and replace that day's rows in
 * `point_readings_flow_1d`. Uses the same local-day boundary as the 1d recompute
 * (`dayToUnixRangeForAggregation`) so flow days tile identically with `agg_1d`.
 */
export async function recomputeFlowMatrixForDay(
  db: PgDb,
  system: SystemForFlow,
  day: CalendarDate,
): Promise<{ rowsUpserted: number }> {
  const [dayStartUnix, dayEndUnix] = dayToUnixRangeForAggregation(
    day,
    system.timezoneOffsetMin,
  );
  const dayStartMs = dayStartUnix * 1000;
  const dayEndMs = dayEndUnix * 1000;
  const dayStr = day.toString();

  const clearDay = () =>
    db
      .delete(pointReadingsFlow1d)
      .where(
        and(
          eq(pointReadingsFlow1d.systemId, system.id),
          eq(pointReadingsFlow1d.day, dayStr),
        ),
      );

  // Point metadata (stem / metric type / unit) for the system.
  const points = await db
    .select({
      index: pointInfo.index,
      stem: pointInfo.logicalPathStem,
      metricType: pointInfo.metricType,
      metricUnit: pointInfo.metricUnit,
    })
    .from(pointInfo)
    .where(eq(pointInfo.systemId, system.id));
  const meta = new Map<
    number,
    {
      stem: string | null;
      metricType: string | null;
      metricUnit: string | null;
    }
  >();
  for (const p of points) {
    meta.set(p.index, {
      stem: p.stem,
      metricType: p.metricType,
      metricUnit: p.metricUnit,
    });
  }

  // The day's 5m averages (00:05 .. 00:00-next-day), system-local.
  const rows = await db
    .select({
      pointId: pointReadingsAgg5m.pointId,
      intervalEnd: pointReadingsAgg5m.intervalEnd,
      avg: pointReadingsAgg5m.avg,
    })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, system.id),
        gte(pointReadingsAgg5m.intervalEnd, new Date(dayStartMs)),
        lte(pointReadingsAgg5m.intervalEnd, new Date(dayEndMs)),
      ),
    )
    .orderBy(asc(pointReadingsAgg5m.intervalEnd));

  if (rows.length === 0) {
    await clearDay();
    return { rowsUpserted: 0 };
  }

  // Dense shared timeline of interval-ends, and per power-point kW arrays aligned to it.
  const timestamps = [
    ...new Set(rows.map((r) => r.intervalEnd.getTime())),
  ].sort((a, b) => a - b);
  const tIndex = new Map<number, number>(timestamps.map((t, i) => [t, i]));

  const pointArrays = new Map<number, (number | null)[]>();
  for (const r of rows) {
    const m = meta.get(r.pointId);
    if (!m || m.metricType !== "power" || !m.stem) continue;
    let arr = pointArrays.get(r.pointId);
    if (!arr) {
      arr = new Array<number | null>(timestamps.length).fill(null);
      pointArrays.set(r.pointId, arr);
    }
    arr[tIndex.get(r.intervalEnd.getTime())!] = toKw(r.avg, m.metricUnit);
  }

  const classified: ClassifiedPoint[] = [];
  for (const [pointId, power] of pointArrays) {
    classified.push({ stem: meta.get(pointId)!.stem!, power });
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
          systemId: system.id,
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
    await tx
      .delete(pointReadingsFlow1d)
      .where(
        and(
          eq(pointReadingsFlow1d.systemId, system.id),
          eq(pointReadingsFlow1d.day, dayStr),
        ),
      );
    if (flowRows.length > 0) {
      await tx.insert(pointReadingsFlow1d).values(flowRows);
    }
  });

  return { rowsUpserted: flowRows.length };
}

/**
 * Daily-cron hook: recompute a system/day's flow matrix in PG. Best-effort — no-op if PG isn't
 * configured, and swallows/logs errors so it can never break the daily aggregation it follows.
 */
export async function recomputeFlowMatrixForDayBestEffort(
  system: SystemForFlow,
  day: CalendarDate,
): Promise<void> {
  if (!planetscaleDb) return;
  try {
    const { rowsUpserted } = await recomputeFlowMatrixForDay(
      planetscaleDb,
      system,
      day,
    );
    console.log(
      `[PG-Flow1d] system=${system.id} day=${day.toString()} rows=${rowsUpserted}`,
    );
  } catch (err) {
    console.error(
      `[PG-Flow1d] recompute failed for system=${system.id} day=${day.toString()}:`,
      err,
    );
  }
}
