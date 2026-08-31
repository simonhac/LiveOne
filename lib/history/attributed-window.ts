/**
 * The sub-daily attributed flow matrix for an arbitrary `[startMs, endMs]` window, served from the
 * materialised `point_readings_flow_attr_1d` rollup wherever the window covers WHOLE local days and
 * live-computed only for the partial edge days — the §1.3c read: a historical D/W Sankey becomes a
 * single indexed range read (~37 ms) instead of folding 2,016 five-minute intervals (~450 ms).
 *
 * Day accounting: the window splits at local midnights (the subject's fixed UTC offset). Fully-
 * covered days come from the rollup; partial edge days — and any full day the rollup hasn't
 * materialised yet — go through `buildAttributedFlowMatrix`, with ADJACENT live days coalesced into
 * one span (see the note at the merge) and the fan-out concurrency-bounded. Consecutive spans TILE under
 * `computeFlowAccounting`'s span-window rule, so summing the returned days equals computing the
 * whole window in one pass — with one knowing exception the rollup itself already carries: an
 * interval spanning a data GAP across midnight belongs to neither day (~0.014 kWh/day typical; see
 * the FLOW_ATTR_VERSION v5 note in battery-provenance-pg.ts). D/W therefore now agrees with M/Y
 * exactly, rather than agreeing with it approximately.
 *
 * Degradation (single-path P3, replacing the retired energy-only `response.flowMatrix`): a live
 * segment whose FULL attributed build throws retries as `buildEnergyOnlyAttributedMatrix` — energy
 * leg exact, metric legs null, everything booked estimated. Only a failure of that too (the DB
 * itself) propagates to the caller's catch.
 */

import { CalendarDate } from "@internationalized/date";
import {
  readAttrRollupRows,
  type AttrRollupRow,
} from "@/lib/aggregation/flow-attr-read";
import {
  buildAttributedFlowMatrix,
  buildEnergyOnlyAttributedMatrix,
} from "@/lib/history/build-attributed-flow-matrix";
import { MIN_ATTR_KWH } from "@/lib/db/planetscale/battery-provenance-pg";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { toDailyFlowMatrices } from "@/lib/aggregation/flow-node-meta";
import type { LogicalSystem } from "@/lib/aggregation/logical-system";
import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on live segments computed at once. A normal request has ≤ 2 (a rolling window's edge days),
 * but the 30m range cap is 13 MONTHS: a long window over unmaterialised history (a new area, an
 * un-backfilled range) coalesces to few spans yet an alternating gap pattern could still yield
 * ~195. Each segment is a full provenance load — several `agg_5m` reads — so an unbounded
 * `Promise.all` would exhaust the connection pool (`PLANETSCALE_POOL_MAX` defaults to 10) and take
 * unrelated requests down with it. Small enough to leave the pool headroom, large enough that the
 * ≤ 2-segment normal case is still fully concurrent.
 */
const LIVE_SEGMENT_CONCURRENCY = 4;

/** Map with a bounded worker pool, preserving input order. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++)
      out[i] = await fn(items[i]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/** One local day's slice of the window. */
export interface DaySegment {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** The slice actually inside the window (epoch-ms UTC). */
  startMs: number;
  endMs: number;
  /** True iff the slice is the whole local day → servable from the rollup. */
  full: boolean;
}

/**
 * Split `[startMs, endMs]` at local midnights for a fixed `tzOffsetMin`. Pure; exported for tests.
 */
export function splitWindowIntoLocalDays(
  startMs: number,
  endMs: number,
  tzOffsetMin: number,
): DaySegment[] {
  const tzMs = tzOffsetMin * 60_000;
  const midnightAtOrBefore = (ms: number) =>
    Math.floor((ms + tzMs) / DAY_MS) * DAY_MS - tzMs;
  const dayString = (dayStartMs: number) => {
    const d = new Date(dayStartMs + tzMs);
    return new CalendarDate(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
    ).toString();
  };
  const segments: DaySegment[] = [];
  for (let d = midnightAtOrBefore(startMs); d < endMs; d += DAY_MS) {
    const segStart = Math.max(d, startMs);
    const segEnd = Math.min(d + DAY_MS, endMs);
    segments.push({
      day: dayString(d),
      startMs: segStart,
      endMs: segEnd,
      full: segStart === d && segEnd === d + DAY_MS,
    });
  }
  return segments;
}

/**
 * Flatten a live-computed 1-day `DailyFlowMatrices` into the rollup row shape so rollup days and
 * live days merge through one `toDailyFlowMatrices` pass. Mirrors `writeAttrRollup`'s row rules:
 * edges at/below `MIN_ATTR_KWH` are dropped, and null metric cells stay null.
 */
function flattenToRows(m: DailyFlowMatrices): AttrRollupRow[] {
  const rows: AttrRollupRow[] = [];
  for (const day of m.days) {
    for (let s = 0; s < m.sources.length; s++) {
      for (let l = 0; l < m.loads.length; l++) {
        const e = day.matrix[s]?.[l] ?? 0;
        if (e <= MIN_ATTR_KWH) continue;
        rows.push({
          day: day.day,
          sourcePath: m.sources[s].id,
          loadPath: m.loads[l].id,
          energyKwh: e,
          emissionsG: day.emissionsG?.[s]?.[l] ?? null,
          renewableKwh: day.renewableKwh?.[s]?.[l] ?? null,
          selfRenewableKwh: day.selfRenewableKwh?.[s]?.[l] ?? null,
          costC: day.costC?.[s]?.[l] ?? null,
          revenueC: day.revenueC?.[s]?.[l] ?? null,
          estimatedKwh: day.estimatedKwh?.[s]?.[l] ?? 0,
        });
      }
    }
  }
  return rows;
}

/** A live segment's attributed build, degrading to the energy-only single-path fallback. */
async function buildLiveSegment(
  handle: number,
  seg: { startMs: number; endMs: number },
  logicalSystem: LogicalSystem,
): Promise<DailyFlowMatrices | null> {
  try {
    return await buildAttributedFlowMatrix(
      handle,
      seg.startMs,
      seg.endMs,
      logicalSystem,
    );
  } catch (error) {
    console.error(
      `[history] attributed segment failed for handle=${handle} ` +
        `[${new Date(seg.startMs).toISOString()}, ${new Date(seg.endMs).toISOString()}] — ` +
        `degrading to energy-only:`,
      error,
    );
    return buildEnergyOnlyAttributedMatrix(
      handle,
      seg.startMs,
      seg.endMs,
      logicalSystem,
    );
  }
}

/**
 * Build the attributed flow matrix for `[startMs, endMs]`, one `days[]` entry per local day —
 * rollup-served where materialised, live-computed at the edges. Returns `null` when no day yields
 * anything ("nothing to serve", same contract as `buildAttributedFlowMatrix`); throws only when
 * even the degraded energy-only build cannot run (caller catches → `attributed-compute-failed`).
 */
export async function buildAttributedFlowWindow(
  handle: number,
  startMs: number,
  endMs: number,
  logicalSystem: LogicalSystem,
): Promise<DailyFlowMatrices | null> {
  const db = requirePlanetscaleDb();
  const segments = splitWindowIntoLocalDays(
    startMs,
    endMs,
    logicalSystem.timezoneOffsetMin,
  );
  const fullDays = segments.filter((s) => s.full);

  // Full days are contiguous (partials only occur at the window's edges) → one indexed range read.
  const rollupRows =
    fullDays.length > 0
      ? await readAttrRollupRows(
          db,
          logicalSystem.areaId,
          fullDays[0].day,
          fullDays[fullDays.length - 1].day,
        )
      : [];

  // A full day with no rollup row (not yet materialised / a brand-new area) degrades to the live
  // compute for that day rather than leaving a hole. NB a materialised-but-empty day (a real no-flow
  // day) is indistinguishable from an unmaterialised one here; recomputing it live just re-derives
  // the same nothing, so the fallback is safe, merely not free.
  const daysWithRows = new Set(rollupRows.map((r) => r.day));
  const liveDays = segments.filter((s) => !s.full || !daysWithRows.has(s.day));

  // Coalesce ADJACENT live days into one span, so a long unmaterialised range costs work
  // proportional to its GAPS, not to its day count. In the normal case (a rolling window's two
  // partial edges, separated by rollup days) nothing merges and per-day results are preserved —
  // which is what makes D/W tile with M/Y exactly. Where days DO merge, the span is computed in one
  // pass and lands as a single `days[]` entry labelled by its first local day; a merged span
  // therefore also keeps the intervals that cross an interior midnight, rather than dropping them
  // the way per-day slicing (and the rollup writer) does. That difference only ever arises where
  // there is no rollup to agree with, and every sub-daily consumer sums `days[]`.
  const liveSegments: { startMs: number; endMs: number }[] = [];
  for (const seg of liveDays) {
    const prev = liveSegments[liveSegments.length - 1];
    if (prev && prev.endMs === seg.startMs) prev.endMs = seg.endMs;
    else liveSegments.push({ startMs: seg.startMs, endMs: seg.endMs });
  }

  const liveResults = await mapBounded(
    liveSegments,
    LIVE_SEGMENT_CONCURRENCY,
    (seg) => buildLiveSegment(handle, seg, logicalSystem),
  );

  const rows: AttrRollupRow[] = [
    ...rollupRows,
    ...liveResults
      .filter((m): m is DailyFlowMatrices => m !== null)
      .flatMap(flattenToRows),
  ];
  if (rows.length === 0) return null;

  const displayNameByStem = new Map<string, string>();
  for (const p of logicalSystem.points) {
    if (!displayNameByStem.has(p.stem))
      displayNameByStem.set(p.stem, p.displayName);
  }
  return toDailyFlowMatrices(rows, displayNameByStem, true);
}
