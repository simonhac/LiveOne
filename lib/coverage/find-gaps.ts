/**
 * Coverage-repair framework — Stage 1: the generic gap-finder (vendor-agnostic).
 *
 * Generalizes the original Amber-only detector: scan `point_readings_agg_5m` for missing intervals in
 * a system's coverage points over a local-day range, parameterized by cadence (→ expected intervals
 * per day) and the local-day bucket offset. One function serves 30-min (Amber, 48/day) and 5-min
 * (OpenElectricity, Sigenergy, 288/day) vendors alike. READ-ONLY.
 */
import { sql } from "drizzle-orm";
import { parseDate } from "@internationalized/date";
import { planetscaleDb } from "@/lib/db/planetscale";
import type { CoveragePoint, CoverageGapDay, PointShortfall } from "./types";

type PgDb = NonNullable<typeof planetscaleDb>;

const DAY_MS = 86400 * 1000;

/** UTC instant of local-midnight of `day` in a zone `offsetMin` minutes east of UTC. */
function localMidnightUtcMs(day: string, offsetMin: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMin * 60_000;
}

/** SQL fragment: the local trading-day ('YYYY-MM-DD') of an interval-END, shifted by `offsetMin`.
 *  The `- 1 second` puts an interval ending at local 00:00 into the PREVIOUS trading day. */
function localDayExpr(offsetMin: number) {
  return sql`to_char(interval_end + (${offsetMin} || ' minutes')::interval - interval '1 second', 'YYYY-MM-DD')`;
}

/** Resolve a provider's expected point tails to this system's point ids (only those that exist). */
export async function resolveCoveragePoints(
  db: PgDb,
  systemId: number,
  tails: readonly string[],
): Promise<CoveragePoint[]> {
  if (tails.length === 0) return [];
  const res = await db.execute(sql`
    SELECT id, physical_path_tail AS tail
    FROM point_info
    WHERE system_id = ${systemId}
      AND physical_path_tail IN (${sql.join(
        tails.map((t) => sql`${t}`),
        sql`, `,
      )})
    ORDER BY id
  `);
  return (res.rows ?? []).map((r) => ({
    id: Number((r as { id: unknown }).id),
    tail: String((r as { tail: unknown }).tail),
  }));
}

/** Inclusive list of local days from `firstDay` to `lastDay` (both 'YYYY-MM-DD'). */
function eachDay(firstDay: string, lastDay: string): string[] {
  const out: string[] = [];
  let d = parseDate(firstDay);
  const end = parseDate(lastDay);
  while (d.compare(end) <= 0) {
    out.push(d.toString());
    d = d.add({ days: 1 });
  }
  return out;
}

/**
 * Find coverage gaps for one system over the local-day window [firstDay, lastDay]. A day is a gap if
 * ANY coverage point has fewer than `expected = 1440/cadenceMinutes` intervals that day (missing rows,
 * not zeros — these vendors emit a row per interval even at zero). Points absent from `point_info` are
 * simply not scanned (a channel a site lacks is never falsely flagged).
 */
export async function findCoverageGaps(
  db: PgDb,
  systemId: number,
  points: CoveragePoint[],
  cadenceMinutes: number,
  bucketOffsetMin: number,
  firstDay: string,
  lastDay: string,
): Promise<CoverageGapDay[]> {
  if (points.length === 0) return [];
  const expected = Math.round(1440 / cadenceMinutes);
  const ids = points.map((p) => p.id);
  // Generous UTC scan bounds covering all of [firstDay, lastDay]; eachDay() restricts to the exact days.
  const windowStartMs = localMidnightUtcMs(firstDay, bucketOffsetMin) - DAY_MS;
  const windowEndMs = localMidnightUtcMs(lastDay, bucketOffsetMin) + 2 * DAY_MS;

  const res = await db.execute(sql`
    SELECT ${localDayExpr(bucketOffsetMin)} AS local_day,
           point_id,
           count(*)::int AS n
    FROM point_readings_agg_5m
    WHERE system_id = ${systemId}
      AND point_id IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})
      AND interval_end >= ${new Date(windowStartMs)}
      AND interval_end <  ${new Date(windowEndMs)}
    GROUP BY 1, 2
  `);

  const counts = new Map<string, Map<number, number>>();
  for (const row of res.rows ?? []) {
    const day = String((row as { local_day: unknown }).local_day);
    const pid = Number((row as { point_id: unknown }).point_id);
    const n = Number((row as { n: unknown }).n);
    if (!counts.has(day)) counts.set(day, new Map());
    counts.get(day)!.set(pid, n);
  }

  const tailById = new Map(points.map((p) => [p.id, p.tail]));
  const gaps: CoverageGapDay[] = [];
  for (const day of eachDay(firstDay, lastDay)) {
    const dayCounts = counts.get(day);
    const short: PointShortfall[] = [];
    let maxPresent = 0;
    for (const p of points) {
      const present = dayCounts?.get(p.id) ?? 0;
      if (present > maxPresent) maxPresent = present;
      const missing = expected - present;
      if (missing > 0)
        short.push({
          tail: tailById.get(p.id)!,
          pointId: p.id,
          present,
          missing,
        });
    }
    if (short.length > 0)
      gaps.push({
        day,
        maxMissing: Math.max(...short.map((s) => s.missing)),
        maxPresent,
        points: short,
      });
  }
  return gaps;
}

/** Best present-count across the coverage points for `(system, day)`. Used by the runner's landing
 *  wait: a day is "landed" when this rises above the pre-repair value (progress) or reaches `expected`. */
export async function countMaxPresent(
  db: PgDb,
  systemId: number,
  points: CoveragePoint[],
  day: string,
  bucketOffsetMin: number,
): Promise<number> {
  if (points.length === 0) return 0;
  const ids = points.map((p) => p.id);
  const res = await db.execute(sql`
    SELECT point_id, count(*)::int AS n
    FROM point_readings_agg_5m
    WHERE system_id = ${systemId}
      AND point_id IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})
      AND ${localDayExpr(bucketOffsetMin)} = ${day}
    GROUP BY point_id
  `);
  let max = 0;
  for (const row of res.rows ?? []) {
    const n = Number((row as { n: unknown }).n);
    if (n > max) max = n;
  }
  return max;
}
