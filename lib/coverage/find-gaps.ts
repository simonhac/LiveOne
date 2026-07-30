/**
 * Coverage-repair framework — Stage 1: the generic gap-finder (vendor-agnostic).
 *
 * Generalizes the original Amber-only detector: scan the 5m aggregates (via the readings DAO —
 * ReadingsDao.countAgg5mByLocalDay / countAgg5mForLocalDay) for missing intervals in a system's
 * coverage points over a local-day range, parameterized by cadence (→ expected intervals per day) and
 * the local-day bucket offset. One function serves 30-min (Amber, 48/day) and 5-min (OpenElectricity,
 * Sigenergy, 288/day) vendors alike. READ-ONLY.
 */
import { sql } from "drizzle-orm";
import { parseDate } from "@internationalized/date";
import { planetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import { Point, type PointId } from "@/lib/ids";
import type { CoveragePoint, CoverageGapDay, PointShortfall } from "./types";

type PgDb = NonNullable<typeof planetscaleDb>;

const DAY_MS = 86400 * 1000;

/** UTC instant of local-midnight of `day` in a zone `offsetMin` minutes east of UTC. */
function localMidnightUtcMs(day: string, offsetMin: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMin * 60_000;
}

/**
 * Resolve a provider's expected point tails to this system's coverage points (only those that exist).
 *
 * Sourced from `points`, not `point_info`: `CoveragePoint.id` used to be `point_info.index`, whose
 * table the terminal window drops and which `points` has no counterpart to. It is now `points.rid` —
 * globally unique, so it keys the internal maps below at least as well, and reproducible after the
 * drop. Both hops (`points.device_id → devices.id`, `devices.rid` = the handle) are FK-backed and
 * NOT NULL, so neither can silently filter a point out.
 */
export async function resolveCoveragePoints(
  db: PgDb,
  systemId: number,
  tails: readonly string[],
): Promise<CoveragePoint[]> {
  if (tails.length === 0) return [];
  // The uuid comes back on the same row as `rid`/`tail` — the readings DAO is keyed on it, so the
  // callers below need no registry lookup at all (slice D).
  const res = await db.execute(sql`
    SELECT p.rid AS rid, p.physical_path AS tail, p.id AS point_uid
    FROM points p
    JOIN devices d ON d.id = p.device_id
    WHERE d.rid = ${systemId}
      AND p.physical_path IN (${sql.join(
        tails.map((t) => sql`${t}`),
        sql`, `,
      )})
    ORDER BY p.rid
  `);
  return (res.rows ?? []).map((r) => ({
    id: Number((r as { rid: unknown }).rid),
    tail: String((r as { tail: unknown }).tail),
    point: Point.encode(String((r as { point_uid: unknown }).point_uid)),
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
  // Generous UTC scan bounds covering all of [firstDay, lastDay]; eachDay() restricts to the exact days.
  const windowStartMs = localMidnightUtcMs(firstDay, bucketOffsetMin) - DAY_MS;
  const windowEndMs = localMidnightUtcMs(lastDay, bucketOffsetMin) + 2 * DAY_MS;

  // Each coverage point already carries its registry identity (resolveCoveragePoints), so there is
  // nothing to look up and nothing that can be missing.
  const pointByRid = new Map<number, PointId>(
    points.map((p) => [p.id, p.point]),
  );
  const ids: PointId[] = points.map((p) => p.point);
  const byPoint = await ReadingsDao.countAgg5mByLocalDay(
    ids,
    { fromMs: windowStartMs, toMs: windowEndMs, offsetMin: bucketOffsetMin },
    db,
  );

  // Rebuild the (local_day → (point rid → count)) map the day-by-day loop below expects.
  const counts = new Map<string, Map<number, number>>();
  for (const p of points) {
    const id = pointByRid.get(p.id);
    if (!id) continue;
    for (const [day, n] of byPoint.get(id) ?? []) {
      if (!counts.has(day)) counts.set(day, new Map());
      counts.get(day)!.set(p.id, n);
    }
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
  const ids: PointId[] = points.map((p) => p.point);
  const byPoint = await ReadingsDao.countAgg5mForLocalDay(
    ids,
    { day, offsetMin: bucketOffsetMin },
    db,
  );
  let max = 0;
  for (const n of byPoint.values()) if (n > max) max = n;
  return max;
}
